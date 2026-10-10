using System;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
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
            var shellType = Type.GetTypeFromProgID("WScript.Shell", true);
            object shell = Activator.CreateInstance(shellType);
            try
            {
                object link = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { shortcutPath });
                Set(link, "TargetPath", installedExe);
                Set(link, "Arguments", Argument);
                Set(link, "Hotkey", Hotkey.ToUpperInvariant());
                Set(link, "Description", "关闭屏幕（电脑继续运行），动鼠标或按任意键亮屏");
                link.GetType().InvokeMember("Save", BindingFlags.InvokeMethod, null, link, null);
                Marshal.FinalReleaseComObject(link);
            }
            finally
            {
                Marshal.FinalReleaseComObject(shell);
            }
            return shortcutPath;
        }

        static void Set(object target, string property, object value)
        {
            target.GetType().InvokeMember(property, BindingFlags.SetProperty, null, target, new[] { value });
        }

        [DllImport("user32.dll")]
        static extern IntPtr SendMessage(IntPtr window, int message, IntPtr wParam, IntPtr lParam);
    }
}
