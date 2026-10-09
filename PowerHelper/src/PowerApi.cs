using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32;

namespace PowerHelper
{
    /// <summary>
    /// Reads and writes settings of the active Windows power plan through powrprof.dll.
    /// The Win32 API is used instead of parsing powercfg output, because that output is
    /// localized (Chinese / Japanese / English Windows all print different labels).
    /// </summary>
    internal static class PowerApi
    {
        // Subgroup and setting GUIDs; the powercfg alias of each is in the comment.
        public static readonly Guid SubVideo = new Guid("7516b95f-f776-4464-8c53-06167f40cc99");          // SUB_VIDEO
        public static readonly Guid VideoIdle = new Guid("3c0bc021-c8a8-4e07-a973-6b14cbcb2b7e");         // VIDEOIDLE (seconds, 0 = never)
        public static readonly Guid SubSleep = new Guid("238c9fa8-0aad-41ed-83f4-97be242c8f20");          // SUB_SLEEP
        public static readonly Guid StandbyIdle = new Guid("29f6c1db-86da-48c5-9fdb-f2b67b1f44da");       // STANDBYIDLE (seconds, 0 = never)
        public static readonly Guid HibernateIdle = new Guid("9d7815a6-7ee4-497e-8888-515a05f02364");     // HIBERNATEIDLE (seconds, 0 = never)
        public static readonly Guid SubButtons = new Guid("4f971e89-eebd-4455-a8de-9e59040e7347");        // SUB_BUTTONS
        public static readonly Guid PowerButtonAction = new Guid("7648efa3-dd9c-4e3e-b566-50f929386280"); // PBUTTONACTION (index)

        public const int ErrorAccessDenied = 5;
        const uint ErrorSuccess = 0;
        const uint ErrorMoreData = 234;
        const int ErrorCancelled = 1223;

        // Byte offsets inside SYSTEM_POWER_CAPABILITIES (76 bytes in total).
        const int SystemS4Offset = 6;
        const int HiberFilePresentOffset = 8;
        const int SystemBatteriesPresentOffset = 30;
        const int PowerCapabilitiesSize = 76;

        internal sealed class Capabilities
        {
            public bool HibernateEnabled;
            public bool HasBattery;
        }

        public static Guid GetActiveScheme()
        {
            IntPtr pointer;
            Check(PowerGetActiveScheme(IntPtr.Zero, out pointer));
            try
            {
                return (Guid)Marshal.PtrToStructure(pointer, typeof(Guid));
            }
            finally
            {
                LocalFree(pointer);
            }
        }

        /// <summary>Returns the plan's display name (localized by Windows), or null if unavailable.</summary>
        public static string GetSchemeName(Guid scheme)
        {
            return ReadString((byte[] buffer, ref uint size) =>
                PowerReadFriendlyName(IntPtr.Zero, ref scheme, IntPtr.Zero, IntPtr.Zero, buffer, ref size));
        }

        /// <summary>Returns Windows' name for a possible value of an index setting, or null if the value does not exist.</summary>
        public static string GetPossibleValueName(Guid subGroup, Guid setting, uint index)
        {
            return ReadString((byte[] buffer, ref uint size) =>
                PowerReadPossibleFriendlyName(IntPtr.Zero, ref subGroup, ref setting, index, buffer, ref size));
        }

        public static uint ReadValue(Guid scheme, Guid subGroup, Guid setting, bool pluggedIn)
        {
            uint value;
            if (pluggedIn)
                Check(PowerReadACValueIndex(IntPtr.Zero, ref scheme, ref subGroup, ref setting, out value));
            else
                Check(PowerReadDCValueIndex(IntPtr.Zero, ref scheme, ref subGroup, ref setting, out value));
            return value;
        }

        /// <summary>Stores a value in the plan. Call <see cref="Activate"/> afterwards for it to take effect.</summary>
        public static void WriteValue(Guid scheme, Guid subGroup, Guid setting, bool pluggedIn, uint value)
        {
            if (pluggedIn)
                Check(PowerWriteACValueIndex(IntPtr.Zero, ref scheme, ref subGroup, ref setting, value));
            else
                Check(PowerWriteDCValueIndex(IntPtr.Zero, ref scheme, ref subGroup, ref setting, value));
        }

        public static void Activate(Guid scheme)
        {
            Check(PowerSetActiveScheme(IntPtr.Zero, ref scheme));
        }

        public static Capabilities GetCapabilities()
        {
            var raw = new byte[PowerCapabilitiesSize];
            if (!GetPwrCapabilities(raw))
                throw new Win32Exception();
            return new Capabilities
            {
                HibernateEnabled = raw[SystemS4Offset] != 0 && raw[HiberFilePresentOffset] != 0,
                HasBattery = raw[SystemBatteriesPresentOffset] != 0,
            };
        }

        /// <summary>
        /// True when Group Policy (e.g. a hospital IT department) enforces this setting,
        /// in which case values written to the plan are overridden.
        /// </summary>
        public static bool IsSetByPolicy(Guid setting)
        {
            try
            {
                using (var machine = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64))
                using (var key = machine.OpenSubKey(@"SOFTWARE\Policies\Microsoft\Power\PowerSettings\" + setting.ToString("D").ToUpperInvariant()))
                {
                    return key != null && (key.GetValue("ACSettingIndex") != null || key.GetValue("DCSettingIndex") != null);
                }
            }
            catch (Exception)
            {
                return false;
            }
        }

        /// <summary>
        /// Runs "powercfg /hibernate on" elevated (turning hibernation on needs administrator rights).
        /// Returns false if the user declined the UAC prompt; re-read <see cref="GetCapabilities"/> for the result.
        /// </summary>
        public static bool EnableHibernate()
        {
            var start = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "powercfg.exe"), "/hibernate on")
            {
                UseShellExecute = true,
                Verb = "runas",
                WindowStyle = ProcessWindowStyle.Hidden,
            };
            try
            {
                using (var process = Process.Start(start))
                {
                    if (process != null)
                        process.WaitForExit();
                }
                return true;
            }
            catch (Win32Exception ex) when (ex.NativeErrorCode == ErrorCancelled)
            {
                return false;
            }
        }

        delegate uint StringReader(byte[] buffer, ref uint size);

        static string ReadString(StringReader read)
        {
            uint size = 0;
            uint result = read(null, ref size);
            if ((result != ErrorSuccess && result != ErrorMoreData) || size == 0)
                return null;
            var buffer = new byte[size];
            if (read(buffer, ref size) != ErrorSuccess)
                return null;
            return Encoding.Unicode.GetString(buffer, 0, (int)size).TrimEnd('\0');
        }

        static void Check(uint result)
        {
            if (result != ErrorSuccess)
                throw new Win32Exception((int)result);
        }

        [DllImport("powrprof.dll")]
        static extern uint PowerGetActiveScheme(IntPtr userRootPowerKey, out IntPtr activePolicyGuid);

        [DllImport("powrprof.dll")]
        static extern uint PowerSetActiveScheme(IntPtr userRootPowerKey, ref Guid schemeGuid);

        [DllImport("powrprof.dll")]
        static extern uint PowerReadACValueIndex(IntPtr rootPowerKey, ref Guid schemeGuid, ref Guid subGroupGuid, ref Guid settingGuid, out uint value);

        [DllImport("powrprof.dll")]
        static extern uint PowerReadDCValueIndex(IntPtr rootPowerKey, ref Guid schemeGuid, ref Guid subGroupGuid, ref Guid settingGuid, out uint value);

        [DllImport("powrprof.dll")]
        static extern uint PowerWriteACValueIndex(IntPtr rootPowerKey, ref Guid schemeGuid, ref Guid subGroupGuid, ref Guid settingGuid, uint value);

        [DllImport("powrprof.dll")]
        static extern uint PowerWriteDCValueIndex(IntPtr rootPowerKey, ref Guid schemeGuid, ref Guid subGroupGuid, ref Guid settingGuid, uint value);

        [DllImport("powrprof.dll")]
        static extern uint PowerReadFriendlyName(IntPtr rootPowerKey, ref Guid schemeGuid, IntPtr subGroupGuid, IntPtr settingGuid, byte[] buffer, ref uint bufferSize);

        [DllImport("powrprof.dll")]
        static extern uint PowerReadPossibleFriendlyName(IntPtr rootPowerKey, ref Guid subGroupGuid, ref Guid settingGuid, uint possibleSettingIndex, byte[] buffer, ref uint bufferSize);

        [DllImport("powrprof.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.U1)]
        static extern bool GetPwrCapabilities([Out] byte[] capabilities);

        [DllImport("kernel32.dll")]
        static extern IntPtr LocalFree(IntPtr memory);
    }
}
