using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;

[assembly: AssemblyTitle("Rovarin")]
[assembly: AssemblyProduct("Rovarin")]
[assembly: AssemblyDescription("Rovarin — Your PC in your pocket.")]
[assembly: AssemblyCompany("Rovarin")]
[assembly: AssemblyVersion("0.2.0.0")]
[assembly: AssemblyFileVersion("0.2.0.0")]

// Fixed Windows GUI entry point: no console, arbitrary commands or paths.
internal static class RovarinLauncher
{
    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length > 1) return 2;
        string mode = args.Length == 0 ? "" : args[0];
        string script;
        switch (mode)
        {
            case "": return DesktopShell.Run();
            case "close-desktop": return DesktopShell.CloseExisting();
            case "web": case "setup": script = "desktop.vbs"; break;
            case "startup": script = "startup.vbs"; break;
            case "disable-startup": script = "startup-disable.vbs"; break;
            default: return 2;
        }
        string directory = AppDomain.CurrentDomain.BaseDirectory;
        string file = Path.Combine(directory, script);
        if (!File.Exists(Path.Combine(directory, "installation.json")) || !File.Exists(file)) return 3;
        try
        {
            var start = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "wscript.exe"));
            start.Arguments = "\"" + file + "\"" + (mode == "setup" ? " setup" : "");
            start.WorkingDirectory = directory;
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.WindowStyle = ProcessWindowStyle.Hidden;
            using (var child = Process.Start(start)) { child.WaitForExit(); return child.ExitCode; }
        }
        catch { return 1; }
    }
}
