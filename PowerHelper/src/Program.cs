using System;
using System.Windows.Forms;

namespace PowerHelper
{
    internal static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            if (args.Length > 0 && string.Equals(args[0], ScreenOff.Argument, StringComparison.OrdinalIgnoreCase))
            {
                ScreenOff.RunFromCommandLine();
                return;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm());
        }
    }
}
