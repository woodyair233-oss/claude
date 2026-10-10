using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace PowerHelper
{
    /// <summary>
    /// Turns only the display off (the PC keeps running); any key or mouse movement turns it back on.
    /// This is the fallback for Modern Standby laptops, where Windows does not let the power button do it.
    /// </summary>
    internal static class ScreenOff
    {
        public const string Argument = "/screenoff";
        public const string Hotkey = "Ctrl+Alt+S";
        public const string ShortcutName = "息屏.lnk";

        // Keys still being released (hotkey) or the mouse button coming up (click) would wake the screen at once.
        public const int DelayMilliseconds = 1000;

        // IShellLink hotkey: modifier flags in the high byte, virtual key in the low byte.
        const ushort HotkeyControl = 0x02;
        const ushort HotkeyAlt = 0x04;
        const ushort HotkeyValue = ((HotkeyControl | HotkeyAlt) << 8) | 'S';

        const int WmSysCommand = 0x0112;
        const int ScMonitorPower = 0xF170;
        const int MonitorOff = 2;

        public static void TurnOff(IntPtr window)
        {
            SendMessage(window, WmSysCommand, (IntPtr)ScMonitorPower, (IntPtr)MonitorOff);
        }

        /// <summary>Entry point for "PowerHelper.exe /screenoff" (used by the desktop shortcut).</summary>
        public static void RunFromCommandLine()
        {
            Thread.Sleep(DelayMilliseconds);
            using (var window = new Form())
            {
                TurnOff(window.Handle);
            }
        }

        /// <summary>
        /// Copies the exe to a fixed folder (so moving or deleting the downloaded file does not break the
        /// shortcut), then creates a desktop shortcut with a global hotkey. Returns the shortcut path.
        /// </summary>
        public static string CreateDesktopShortcut(string exePath)
        {
            string installDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PowerHelper");
            Directory.CreateDirectory(installDir);
            string installedExe = Path.Combine(installDir, "PowerHelper.exe");
            if (!string.Equals(Path.GetFullPath(exePath), installedExe, StringComparison.OrdinalIgnoreCase))
                File.Copy(exePath, installedExe, true);

            // Windows only honours shortcut hotkeys for shortcuts on the desktop or in the Start menu.
            string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory, Environment.SpecialFolderOption.Create);
            string shortcutPath = Path.Combine(desktop, ShortcutName);

            // IShellLinkW keeps Chinese names and paths intact; WScript.Shell goes through the ANSI code page
            // and turns them into "??" on English / Japanese Windows.
            var link = (IShellLinkW)new ShellLink();
            try
            {
                link.SetPath(installedExe);
                link.SetArguments(Argument);
                link.SetWorkingDirectory(installDir);
                link.SetDescription("关闭屏幕（电脑继续运行），动鼠标或按任意键亮屏");
                link.SetHotkey(HotkeyValue);
                ((IPersistFile)link).Save(shortcutPath, true);
            }
            finally
            {
                Marshal.FinalReleaseComObject(link);
            }
            return shortcutPath;
        }

        [DllImport("user32.dll")]
        static extern IntPtr SendMessage(IntPtr window, int message, IntPtr wParam, IntPtr lParam);

        [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
        class ShellLink
        {
        }

        // Methods must stay in vtable order, including the unused getters.
        [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
        interface IShellLinkW
        {
            void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder file, int maxPath, IntPtr findData, uint flags);
            void GetIDList(out IntPtr idList);
            void SetIDList(IntPtr idList);
            void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder name, int maxName);
            void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string name);
            void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder dir, int maxPath);
            void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string dir);
            void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder args, int maxPath);
            void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string args);
            void GetHotkey(out ushort hotkey);
            void SetHotkey(ushort hotkey);
            void GetShowCmd(out int showCmd);
            void SetShowCmd(int showCmd);
            void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder iconPath, int maxIconPath, out int icon);
            void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string iconPath, int icon);
            void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string relativePath, uint reserved);
            void Resolve(IntPtr window, uint flags);
            void SetPath([MarshalAs(UnmanagedType.LPWStr)] string file);
        }
    }
}
