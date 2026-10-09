using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

// A client of the existing dashboard. No PIN handling, host objects, HTTP API,
// telemetry collector, or client-supplied command/path bridge lives here.
internal static class DesktopShell
{
    // Bound by the local build to its companion installer. This is integrity,
    // not publisher authentication: the alpha installer still requires explicit UAC.
    internal const string MaintenanceSetupHash = "";
    internal static string MaintenanceSetupPath { get { return Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "RovarinMaintenanceSetup.exe"); } }
    internal static FileStream OpenMaintenanceSetup() {
        if (MaintenanceSetupHash.Length != 64) throw new IOException("Maintenance setup was not bundled by this build.");
        AssertPlain(MaintenanceSetupPath);
        var info = new FileInfo(MaintenanceSetupPath);
        if (!info.Exists || (info.Attributes & FileAttributes.ReparsePoint) != 0 || info.Length < 1 || info.Length > 32 * 1024 * 1024) throw new IOException("Maintenance setup is missing or unsafe.");
        var file = new FileStream(MaintenanceSetupPath, FileMode.Open, FileAccess.Read, FileShare.Read);
        try {
            using (var sha = SHA256.Create()) {
                string hash = BitConverter.ToString(sha.ComputeHash(file)).Replace("-", "").ToLowerInvariant();
                if (hash != MaintenanceSetupHash) throw new IOException("Maintenance setup integrity failed.");
            }
            return file;
        } catch { file.Dispose(); throw; }
    }
    internal static readonly string AppDirectory = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
    internal static readonly string RootDirectory = Path.GetDirectoryName(AppDirectory);
    internal static readonly string DataDirectory = ResolveDataDirectory();
    private static string ResolveDataDirectory() {
        string marker = Path.Combine(AppDirectory, ".rovarin-development-state.json");
        if (new FileInfo(Path.Combine(AppDirectory, "installation.json")).Exists || !File.Exists(marker)) return Path.Combine(RootDirectory, "data");
        AssertPlain(marker);
        var policy = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(marker));
        if (new FileInfo(marker).Length > 128 || policy.Count != 1 || Convert.ToInt32(policy["schema"]) != 1) throw new IOException("Invalid development storage policy.");
        string identity;
        using (var sha = SHA256.Create()) identity = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(Path.GetFullPath(AppDirectory).ToLowerInvariant()))).Replace("-", "").ToLowerInvariant();
        string directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RovarinDevelopment", identity);
        AssertPlain(directory);
        if (!File.Exists(Path.Combine(directory, "config.json"))) throw new IOException("Migrated development configuration missing.");
        return directory;
    }
    internal static readonly string ProfileDirectory = Path.Combine(RootDirectory, "desktop-profile");
    internal static readonly string Identity = BuildIdentity();
    internal static string BuildIdentity()
    {
        using (var sha = SHA256.Create())
            return "Local\\Rovarin.Desktop." + BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(
                AppDirectory.ToUpperInvariant() + WindowsIdentity.GetCurrent().User.Value))).Replace("-", "");
    }
    internal static void AssertPlain(string path)
    {
        for (var directory = new DirectoryInfo(path); directory != null; directory = directory.Parent)
            if (directory.Exists && (directory.Attributes & FileAttributes.ReparsePoint) != 0)
                throw new IOException("Desktop storage is redirected.");
    }
    internal static bool Installed()
    {
        return File.Exists(Path.Combine(AppDirectory, "installation.json")) &&
            File.Exists(Path.Combine(AppDirectory, "scripts", "desktop-host.ps1"));
    }
    internal static EventWaitHandle CreateEvent(string suffix)
    {
        var security = new EventWaitHandleSecurity();
        security.AddAccessRule(new EventWaitHandleAccessRule(WindowsIdentity.GetCurrent().User,
            EventWaitHandleRights.FullControl, AccessControlType.Allow));
        bool created;
        return new EventWaitHandle(false, EventResetMode.AutoReset, Identity + suffix, out created, security);
    }
    internal static int Run()
    {
        if (!Installed()) return 3;
        try
        {
            var security = new MutexSecurity();
            security.AddAccessRule(new MutexAccessRule(WindowsIdentity.GetCurrent().User, MutexRights.FullControl, AccessControlType.Allow));
            bool created;
            using (var mutex = new Mutex(false, Identity + ".mutex", out created, security))
            {
                bool acquired;
                try { acquired = mutex.WaitOne(0); } catch (AbandonedMutexException) { acquired = true; }
                if (!acquired) { using (var open = CreateEvent(".open")) open.Set(); return 0; }
                try
                {
                    Application.EnableVisualStyles();
                    Application.SetCompatibleTextRenderingDefault(false);
                    using (var open = CreateEvent(".open"))
                    using (var close = CreateEvent(".close"))
                    using (var window = new DesktopWindow())
                    {
                        var reopen = ThreadPool.RegisterWaitForSingleObject(open, delegate { window.PostOpen(); }, null, -1, false);
                        var exit = ThreadPool.RegisterWaitForSingleObject(close, delegate { window.PostExit(); }, null, -1, false);
                        try { Application.Run(window); }
                        finally { reopen.Unregister(null); exit.Unregister(null); }
                    }
                }
                finally { mutex.ReleaseMutex(); }
            }
            return 0;
        }
        catch { MessageBox.Show("Rovarin could not open safely. Try reopening Rovarin. No unrelated process was stopped.", "Rovarin", MessageBoxButtons.OK, MessageBoxIcon.Information); return 1; }
    }
    internal static int CloseExisting()
    {
        if (!Installed()) return 3;
        try
        {
            using (var mutex = Mutex.OpenExisting(Identity + ".mutex"))
            using (var close = CreateEvent(".close"))
            {
                close.Set();
                bool stopped;
                try { stopped = mutex.WaitOne(10000); } catch (AbandonedMutexException) { stopped = true; }
                if (!stopped) return 1;
                mutex.ReleaseMutex();
            }
            return 0;
        }
        catch (WaitHandleCannotBeOpenedException) { return 0; }
        catch { return 1; }
    }
    internal static ProcessStartInfo Script(string name)
    {
        // Call sites use fixed literal script names only. No input from the page.
        return new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe")) {
            Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + Path.Combine(AppDirectory, "scripts", name) + "\"",
            WorkingDirectory = AppDirectory, UseShellExecute = false, CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden, RedirectStandardOutput = true, RedirectStandardError = true
        };
    }
}

internal sealed class DesktopWindow : Form
{
    private readonly Panel recovery = new Panel { Dock = DockStyle.Fill, BackColor = Color.FromArgb(15, 22, 34) };
    private readonly Label title = new Label { AutoSize = false, TextAlign = ContentAlignment.MiddleCenter, ForeColor = Color.White, Font = new Font("Segoe UI", 23, FontStyle.Bold) };
    private readonly Label description = new Label { AutoSize = false, TextAlign = ContentAlignment.MiddleCenter, ForeColor = Color.FromArgb(180, 197, 214), Font = new Font("Segoe UI", 11) };
    private readonly FlowLayoutPanel actions = new FlowLayoutPanel { AutoSize = false, FlowDirection = FlowDirection.LeftToRight };
    private readonly Button retry = new Button { Text = "Try again", Width = 130, Height = 42 };
    private readonly Button runtimeLink = new Button { Text = "Install WebView2", Width = 155, Height = 42 };
    private readonly Button desktopExit = new Button { Text = "×", FlatStyle = FlatStyle.Flat, ForeColor = Color.FromArgb(148,163,184), BackColor = Color.FromArgb(12,20,32), Font = new Font("Segoe UI",16), TabStop = true, AccessibleName = "Exit desktop app" };
    private readonly Button desktopMinimize = new Button { Text = "−", FlatStyle = FlatStyle.Flat, ForeColor = Color.FromArgb(148,163,184), BackColor = Color.FromArgb(12,20,32), Font = new Font("Segoe UI",16), TabStop = true, AccessibleName = "Minimize Rovarin" };
    private readonly NotifyIcon tray;
    private WebView2 view;
    private string origin;
    private bool busy, exiting, initialized, loading, visibilityPending;
    private Process preparation;
    private Rectangle normalBounds;
    private bool wasMaximized;
    private bool loginPresentation, changingBounds, lockUsesDwmCorners;
    private TaskCompletionSource<string> addressRequest;
    private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 8192, RecursionLimit = 8 };
    [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
    [StructLayout(LayoutKind.Sequential)] private struct FrameMargins { public int Left, Right, Top, Bottom; }
    [DllImport("dwmapi.dll")] private static extern int DwmExtendFrameIntoClientArea(IntPtr hwnd, ref FrameMargins margins);
    [DllImport("user32.dll")] private static extern bool ReleaseCapture();
    [DllImport("user32.dll")] private static extern IntPtr SendMessage(IntPtr hwnd, int message, IntPtr wparam, IntPtr lparam);

    internal DesktopWindow()
    {
        Text = "Rovarin"; MinimumSize = new Size(760, 560); Size = new Size(900, 680);
        FormBorderStyle = FormBorderStyle.None; ControlBox = false;
        MaximizedBounds = Screen.GetWorkingArea(this);
        StartPosition = FormStartPosition.CenterScreen; AutoScaleMode = AutoScaleMode.Dpi;
        BackColor = recovery.BackColor;
        Icon = new Icon(Path.Combine(DesktopShell.AppDirectory, "Rovarin.ico"));
        RestoreBoundsFromDisk();
        normalBounds = WindowState == FormWindowState.Maximized ? RestoreBounds : Bounds;
        wasMaximized = WindowState == FormWindowState.Maximized;
        Controls.Add(recovery); recovery.Controls.Add(title); recovery.Controls.Add(description); recovery.Controls.Add(actions);
        desktopExit.FlatAppearance.BorderSize = 0;
        desktopExit.FlatAppearance.MouseOverBackColor = Color.FromArgb(115,35,48);
        desktopExit.Click += delegate { ExitShell(); };
        Controls.Add(desktopExit);
        desktopMinimize.FlatAppearance.BorderSize = 0;
        desktopMinimize.FlatAppearance.MouseOverBackColor = Color.FromArgb(35,52,71);
        desktopMinimize.Click += delegate { WindowState = FormWindowState.Minimized; };
        Controls.Add(desktopMinimize);
        MouseEventHandler dragRecovery = delegate(object sender, MouseEventArgs e) {
            if (e.Button == MouseButtons.Left) { ReleaseCapture(); SendMessage(Handle, 0xA1, new IntPtr(2), IntPtr.Zero); }
        };
        recovery.MouseDown += dragRecovery; title.MouseDown += dragRecovery; description.MouseDown += dragRecovery;
        foreach (var button in new[] { retry, runtimeLink }) {
            button.FlatStyle = FlatStyle.Flat; button.ForeColor = Color.White; button.BackColor = Color.FromArgb(35, 52, 71);
            button.FlatAppearance.BorderSize = 0; button.Cursor = Cursors.Hand; actions.Controls.Add(button);
        }
        retry.Click += async delegate { await StartAsync(false); };
        runtimeLink.Click += delegate { External("https://developer.microsoft.com/microsoft-edge/webview2/#download-section"); };
        var menu = new ContextMenuStrip();
        menu.Items.Add("Open Rovarin", null, delegate { OpenWindow(); });
        menu.Items.Add("Copy Mobile Address", null, async delegate { await CopyAddressAsync(); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Restart Rovarin Backend…", null, async delegate {
            if (!busy && MessageBox.Show(this, "Restart the backend? Connected dashboards will reconnect and require the PIN again.", "Rovarin", MessageBoxButtons.OKCancel, MessageBoxIcon.Information) == DialogResult.OK)
                await StartAsync(true);
        });
        menu.Items.Add("Exit Desktop App", null, delegate { ExitShell(); });
        tray = new NotifyIcon { Icon = Icon, Text = "Rovarin", Visible = true, ContextMenuStrip = menu };
        tray.DoubleClick += delegate { OpenWindow(); };
        Shown += async delegate { await StartAsync(false); };
        Resize += delegate { LayoutRecovery(); if (!loginPresentation && !changingBounds) { if (WindowState == FormWindowState.Normal) normalBounds = Bounds; wasMaximized = WindowState == FormWindowState.Maximized; } QueueVisibility(); };
        Move += delegate { if (!loginPresentation && !changingBounds && WindowState == FormWindowState.Normal) normalBounds = Bounds; };
        FormClosing += delegate(object sender, FormClosingEventArgs e) {
            SaveBounds();
            if (!exiting && e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; Hide(); QueueVisibility(); }
        };
        FormClosed += delegate { if (updateTimer != null) updateTimer.Dispose(); tray.Visible = false; tray.Dispose(); if (view != null) view.Dispose(); StopPreparation(); };
        ApplyLoginPresentation(true);
        State("Opening Rovarin", "Starting or reusing your local server…", false, false);
    }
    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        // DWM styling without a visible Windows caption or permanent controls.
        ApplyWindowChrome();
    }
    private void ApplyWindowChrome() {
        // Own the frame as well as its paint messages. DWM can otherwise draw
        // a second light caption-button strip over the custom client controls.
        try {
            int disabled = 1, dark = 1, rounded = 2;
            int background = ColorTranslator.ToWin32(Color.FromArgb(12,20,32));
            int foreground = ColorTranslator.ToWin32(Color.FromArgb(148,163,184));
            // Windows 11's compositor supplies antialiased corners/shadow. A
            // custom pixel region disables those effects; use it only as fallback.
            bool usesDwmCorners = Environment.OSVersion.Version.Build >= 22000 &&
                DwmSetWindowAttribute(Handle, 33, ref rounded, 4) == 0;
            lockUsesDwmCorners = loginPresentation && usesDwmCorners;
            // Enable compositor rounding/shadow for the normal desktop too.
            // Windows owns square edges while maximized; resize semantics stay intact.
            int policy = usesDwmCorners ? 2 : disabled;
            int border = usesDwmCorners ? unchecked((int)0xFFFFFFFE) : background;
            var margins = new FrameMargins { Left = usesDwmCorners ? 1 : 0, Right = usesDwmCorners ? 1 : 0, Top = usesDwmCorners ? 1 : 0, Bottom = usesDwmCorners ? 1 : 0 };
            DwmSetWindowAttribute(Handle, 2, ref policy, 4);
            DwmExtendFrameIntoClientArea(Handle, ref margins);
            DwmSetWindowAttribute(Handle, 34, ref border, 4); // suppress the system border in lock mode
            DwmSetWindowAttribute(Handle, 20, ref dark, 4);
            DwmSetWindowAttribute(Handle, 33, ref rounded, 4);
            DwmSetWindowAttribute(Handle, 35, ref background, 4);
            DwmSetWindowAttribute(Handle, 36, ref foreground, 4);
        } catch { }
    }
    protected override CreateParams CreateParams {
        get {
            var value = base.CreateParams;
            // Retain system/taskbar keyboard actions and resize/snap semantics.
            value.Style |= 0x80000 | 0x20000; // system menu / minimize
            if (loginPresentation) value.Style &= ~(0x10000 | 0x40000); // no maximize / resize frame
            else value.Style |= 0x10000 | 0x40000;
            return value;
        }
    }
    protected override void WndProc(ref Message message) {
        // Draggable WebView regions retain native move semantics, but lock mode
        // never maximizes/resizes on double-click or through the system menu.
        if (loginPresentation && (message.Msg == 0xA3 || (message.Msg == 0x112 &&
            ((message.WParam.ToInt64() & 0xFFF0) == 0xF030 || (message.WParam.ToInt64() & 0xFFF0) == 0xF000)))) {
            message.Result = IntPtr.Zero; return;
        }
        // The entire frame is client-owned. Default nonclient painting can draw
        // legacy caption buttons over our dark controls after activation/resize.
        if (WindowState != FormWindowState.Minimized) {
            if (message.Msg == 0x85) { message.Result = IntPtr.Zero; return; } // WM_NCPAINT
            if (message.Msg == 0x86) { // WM_NCACTIVATE: preserve activation without repainting.
                message.LParam = new IntPtr(-1);
                DefWndProc(ref message);
                return;
            }
        }
        if (message.Msg == 0x83 && message.WParam != IntPtr.Zero) { message.Result = IntPtr.Zero; return; }
        if (message.Msg == 0x84 && !loginPresentation && WindowState == FormWindowState.Normal) {
            long coordinates = message.LParam.ToInt64();
            Point point = PointToClient(new Point((short)(coordinates & 0xffff), (short)((coordinates >> 16) & 0xffff)));
            int edge = Math.Max(5, (int)(6 * DeviceDpi / 96.0));
            bool left = point.X < edge, right = point.X >= ClientSize.Width - edge;
            bool top = point.Y < edge, bottom = point.Y >= ClientSize.Height - edge;
            int hit = top ? (left ? 13 : right ? 14 : 12) : bottom ? (left ? 16 : right ? 17 : 15) : left ? 10 : right ? 11 : 0;
            if (hit != 0) { message.Result = new IntPtr(hit); return; }
        }
        base.WndProc(ref message);
        if (message.Msg == 0x31A || message.Msg == 0x31E) ApplyWindowChrome(); // theme/composition changed
    }
    internal void PostOpen() { try { if (IsHandleCreated && !IsDisposed) BeginInvoke((Action)OpenWindow); } catch (InvalidOperationException) { } }
    internal void PostExit() { try { if (IsHandleCreated && !IsDisposed) BeginInvoke((Action)ExitShell); } catch (InvalidOperationException) { } }
    private void OpenWindow() { Show(); if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal; Activate(); QueueVisibility(); }
    private async void ExitShell() {
        if (exiting) return;
        exiting = true;
        // A stalled WebView must not leave the native X permanently waiting.
        // Normal release is attempted; the existing lease TTL covers a dead view.
        try { if (view != null && initialized) await Task.WhenAny(ReleaseForExitAsync(), Task.Delay(2000)); }
        finally { if (!IsDisposed) Close(); }
    }
    private async Task ReleaseForExitAsync() {
        try {
            if (view != null && !view.IsDisposed && view.CoreWebView2 != null) {
                await view.CoreWebView2.ExecuteScriptAsync("if(typeof releaseMonitoringLease==='function')releaseMonitoringLease();window.dispatchEvent(new CustomEvent('pc-monitor-desktop-visibility',{detail:{visible:false}}));");
                await Task.Delay(250);
            }
            await SetClientVisibilityAsync(false);
        } catch { }
    }
    private void ApplyLoginPresentation(bool login) {
        if (loginPresentation == login || exiting || IsDisposed) return;
        changingBounds = true;
        try {
            if (login && !loginPresentation) {
                if (WindowState == FormWindowState.Normal) normalBounds = Bounds;
                wasMaximized = WindowState == FormWindowState.Maximized;
            }
            loginPresentation = login;
            // WebView2 is a child HWND: leave the native resize hit-test band
            // reachable instead of letting its content swallow edge drags.
            Padding = login ? Padding.Empty : new Padding(Math.Max(5, (int)(6 * DeviceDpi / 96.0)));
            UpdateStyles(); // apply the mode before Windows computes restore/client bounds
            WindowState = FormWindowState.Normal;
            MinimumSize = login ? new Size(320, 320) : new Size(760, 560);
            if (login) {
                var area = Screen.FromControl(this).WorkingArea;
                int width = Math.Min((int)(360 * DeviceDpi / 96.0), area.Width), height = Math.Min((int)(440 * DeviceDpi / 96.0), area.Height);
                Bounds = new Rectangle(area.Left + (area.Width - width) / 2, area.Top + (area.Height - height) / 2, width, height);
            } else {
                Bounds = normalBounds;
                if (wasMaximized) WindowState = FormWindowState.Maximized;
            }
        } finally { changingBounds = false; ApplyWindowChrome(); LayoutRecovery(); }
    }
    private void ApplyLockOutline() {
        // A shaped, fully hit-testable native window, not transparent padding.
        // Restore the normal window region when the shared document unlocks.
        Region previous = Region;
        if (!loginPresentation || lockUsesDwmCorners) Region = null;
        else {
            int diameter = Math.Min((int)(48 * DeviceDpi / 96.0), Math.Min(ClientSize.Width, ClientSize.Height));
            if (diameter <= 0) return;
            using (var outline = new System.Drawing.Drawing2D.GraphicsPath()) {
                outline.AddArc(0, 0, diameter, diameter, 180, 90);
                outline.AddArc(ClientSize.Width - diameter, 0, diameter, diameter, 270, 90);
                outline.AddArc(ClientSize.Width - diameter, ClientSize.Height - diameter, diameter, diameter, 0, 90);
                outline.AddArc(0, ClientSize.Height - diameter, diameter, diameter, 90, 90);
                outline.CloseFigure();
                Region = new Region(outline);
            }
        }
        if (previous != null) previous.Dispose();
    }
    private async Task FitLoginCardAsync(CoreWebView2 core) {
        // Measure the canonical card at the current DPI; no second login UI.
        await core.ExecuteScriptAsync("document.documentElement.classList.toggle('native-lock-dwm'," + (lockUsesDwmCorners ? "true" : "false") + ")");
        string measured = await core.ExecuteScriptAsync("Math.ceil(document.querySelector('.login-card').getBoundingClientRect().height * devicePixelRatio)");
        int height;
        if (!loginPresentation || exiting || IsDisposed || !Int32.TryParse(measured, out height)) return;
        var area = Screen.FromControl(this).WorkingArea;
        height = Math.Min(area.Height, Math.Max(MinimumSize.Height, Math.Min(640 * DeviceDpi / 96, height)));
        changingBounds = true;
        try { Size = new Size(Width, height); }
        finally { changingBounds = false; LayoutRecovery(); }
    }
    private void StopPreparation() {
        // This is ONLY the helper we spawned/hold. Never kills a Node/backend.
        try { if (preparation != null && !preparation.HasExited) preparation.Kill(); } catch { }
    }
    private void LayoutRecovery() {
        desktopExit.Visible = !loginPresentation; desktopMinimize.Visible = !loginPresentation;
        ApplyLockOutline();
        int scaleHeight = (int)(36 * DeviceDpi / 96.0), scaleWidth = (int)(40 * DeviceDpi / 96.0);
        desktopExit.SetBounds(ClientSize.Width - scaleWidth, 0, scaleWidth, scaleHeight);
        desktopMinimize.SetBounds(ClientSize.Width - scaleWidth * 2, 0, scaleWidth, scaleHeight);
        desktopExit.BringToFront();
        desktopMinimize.BringToFront();
        int y = Math.Max(50, (ClientSize.Height - 210) / 2);
        title.SetBounds(20, y, ClientSize.Width - 40, 60);
        description.SetBounds(60, y + 67, ClientSize.Width - 120, 78);
        int actionWidth = (retry.Visible ? retry.Width + retry.Margin.Horizontal : 0) + (runtimeLink.Visible ? runtimeLink.Width + runtimeLink.Margin.Horizontal : 0);
        actions.SetBounds(Math.Max(20, (ClientSize.Width - actionWidth) / 2), y + 150, actionWidth, 55);
    }
    private void State(string heading, string message, bool failed, bool missingRuntime) {
        title.Text = heading; description.Text = message; retry.Visible = failed; runtimeLink.Visible = missingRuntime;
        recovery.Visible = true; recovery.BringToFront(); LayoutRecovery();
    }
    internal static bool IsDashboardUri(string value, string trustedOrigin) {
        Uri uri, trusted;
        return Uri.TryCreate(value, UriKind.Absolute, out uri) && Uri.TryCreate(trustedOrigin, UriKind.Absolute, out trusted) &&
            uri.Scheme == "http" && uri.Host == "127.0.0.1" && uri.Port == trusted.Port && String.IsNullOrEmpty(uri.UserInfo);
    }
    private async Task<string> RunHelperAsync(string name, int timeout) {
        using (var child = Process.Start(DesktopShell.Script(name))) {
            preparation = child;
            var output = child.StandardOutput.ReadToEndAsync(); var errors = child.StandardError.ReadToEndAsync();
            bool done = await Task.Run(() => child.WaitForExit(timeout));
            if (!done) { try { child.Kill(); } catch { } throw new IOException("Local helper timed out."); }
            await errors; var result = await output;
            if (child.ExitCode != 0 || result.Length > 8192) throw new IOException("Local startup was not confirmed.");
            preparation = null; return result;
        }
    }
    private string desktopCredential;
    private bool securityBusy;
    private async Task<Dictionary<string, object>> NativeRequestAsync(string route, object body) {
        if (String.IsNullOrEmpty(desktopCredential)) desktopCredential = (await RunHelperAsync("native-trust.ps1", 15000)).Trim();
        if (desktopCredential.Length != 44) throw new IOException("Desktop trust unavailable.");
        var request = (HttpWebRequest)WebRequest.Create(origin + route);
        request.Method = "POST"; request.ContentType = "application/json"; request.Timeout = 30000; request.ReadWriteTimeout = 30000;
        request.AllowAutoRedirect = false; request.Proxy = null;
        request.Headers["Origin"] = origin;
        request.Headers["X-PC-Monitor-Desktop"] = desktopCredential;
        request.CookieContainer = new CookieContainer();
        var cookies = await view.CoreWebView2.CookieManager.GetCookiesAsync(origin);
        foreach (var cookie in cookies) if (cookie.Name == "pc_monitor_session") request.CookieContainer.Add(new Cookie(cookie.Name, cookie.Value, "/", "127.0.0.1"));
        byte[] bytes = Encoding.UTF8.GetBytes(json.Serialize(body)); request.ContentLength = bytes.Length;
        using (var stream = await request.GetRequestStreamAsync()) await stream.WriteAsync(bytes, 0, bytes.Length);
        using (var response = (HttpWebResponse)await request.GetResponseAsync()) {
            using (var reader = new StreamReader(response.GetResponseStream())) {
                var text = await reader.ReadToEndAsync();
                if (text.Length > 4096) throw new IOException("Invalid security response.");
                var result = json.Deserialize<Dictionary<string, object>>(text);
                foreach (Cookie cookie in response.Cookies) if (cookie.Name == "pc_monitor_session") {
                    var nativeCookie = view.CoreWebView2.CookieManager.CreateCookie(cookie.Name, cookie.Value, "127.0.0.1", "/");
                    nativeCookie.IsHttpOnly = true; nativeCookie.SameSite = CoreWebView2CookieSameSiteKind.Strict;
                    nativeCookie.Expires = DateTime.Now.AddDays(90);
                    view.CoreWebView2.CookieManager.AddOrUpdateCookie(nativeCookie);
                }
                return result;
            }
        }
    }
    private bool startupBusy;
    private async void StartupActionAsync(string message) {
        if (startupBusy || busy || exiting || loginPresentation || view == null) return;
        startupBusy = true;
        try {
            // Revalidate the existing authenticated native context before touching Windows.
            await NativeRequestAsync("/api/desktop/security", new { action = "status" });
            string action = message == "startup-enable" ? "Enable" : message == "startup-disable" ? "Disable" : "Status";
            var start = DesktopShell.Script("native-startup.ps1");
            start.Arguments += " -Action " + action; // fixed enum, never a frontend command/path
            using (var child = Process.Start(start)) {
                var output = child.StandardOutput.ReadToEndAsync(); var errors = child.StandardError.ReadToEndAsync();
                if (!await Task.Run(() => child.WaitForExit(10000))) { child.Kill(); throw new IOException("Startup helper timed out."); }
                string text = await output; await errors;
                if (child.ExitCode != 0 || text.Length > 1024) throw new IOException("Startup state unavailable.");
                var state = json.Deserialize<Dictionary<string, object>>(text);
                view.CoreWebView2.PostWebMessageAsJson(json.Serialize(new { kind = "startup-state", available = Convert.ToBoolean(state["available"]), enabled = Convert.ToBoolean(state["enabled"]) }));
            }
        } catch {
            if (!exiting && view != null && !view.IsDisposed) view.CoreWebView2.PostWebMessageAsJson(json.Serialize(new { kind = "startup-state", available = false, enabled = false }));
        } finally { startupBusy = false; }
    }
    private bool updateBusy;
    private string pendingUpdateAction;
    private System.Windows.Forms.Timer updateTimer;
    private void PostUpdate(Dictionary<string, object> status) {
        if (!exiting && view != null && !view.IsDisposed) view.CoreWebView2.PostWebMessageAsJson(json.Serialize(new { kind = "updates-state", status = status }));
    }
    private async void UpdateActionAsync(string message) {
        if (busy || exiting || view == null) return;
        if (updateBusy) { if (message != "updates-automatic") pendingUpdateAction = message; return; }
        updateBusy = true;
        try {
            if (message == "updates-notes") {
                var notes = await NativeRequestAsync("/api/desktop/updates", new { action = "status" });
                string url = Convert.ToString(notes["releaseUrl"]);
                Uri parsed;
                if (Uri.TryCreate(url, UriKind.Absolute, out parsed) && parsed.Scheme == "https" && parsed.Host == "github.com" && parsed.AbsolutePath.StartsWith("/DontMovePlease/Rovarin/releases/tag/v", StringComparison.Ordinal) && String.IsNullOrEmpty(parsed.UserInfo) && parsed.IsDefaultPort) External(url);
                PostUpdate(notes); return;
            }
            string action = message == "updates-check" ? "check" : message == "updates-automatic" ? "automatic" : message == "updates-preference" ? "preference" : "status";
            if (message != "updates-install") { PostUpdate(await NativeRequestAsync("/api/desktop/updates", new { action = action })); return; }
            var before = await NativeRequestAsync("/api/desktop/updates", new { action = "status" });
            if (Convert.ToBoolean(before["busy"]) || !Convert.ToBoolean(before["installed"]) || !Convert.ToBoolean(before["available"])) throw new IOException("Update unavailable.");
            if (MessageBox.Show(this, "Download and verify the official Rovarin update, then open the Windows installer? Your PIN and settings will be preserved. Installation begins only when you continue in the installer.", "Update Rovarin", MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) != DialogResult.Yes) { PostUpdate(before); return; }
            await NativeRequestAsync("/api/desktop/updates", new { action = "download" });
            var deadline = DateTime.UtcNow.AddSeconds(205);
            while (!exiting && !IsDisposed) {
                var status = await NativeRequestAsync("/api/desktop/updates", new { action = "status" });
                PostUpdate(status);
                string state = Convert.ToString(status["state"]);
                if (state == "ready") break;
                if (state == "failed" || (!Convert.ToBoolean(status["busy"]) && state != "ready") || DateTime.UtcNow >= deadline) throw new IOException("Download unconfirmed.");
                // Bounded update-operation feedback only; no telemetry or idle poller.
                await Task.Delay(1000);
            }
            if (exiting || IsDisposed) return;
            await NativeRequestAsync("/api/desktop/updates", new { action = "prepare" });
            Dictionary<string, object> handoff = null;
            try { handoff = json.Deserialize<Dictionary<string, object>>(await RunHelperAsync("installed-update.ps1", 20000)); }
            catch { }
            if (handoff == null || !Convert.ToBoolean(handoff["launched"])) {
                try { await NativeRequestAsync("/api/desktop/updates", new { action = "cancel" }); } catch { }
                throw new IOException("Installer launch unconfirmed.");
            }
            // Inno closes this shell via existing IPC when upgrade actually begins.
            view.CoreWebView2.PostWebMessageAsJson(json.Serialize(new { kind = "updates-error", message = "The verified Windows installer is open. Continue there to upgrade; cancelling leaves Rovarin unchanged." }));
        } catch {
            if (message != "updates-automatic" && !exiting && view != null && !view.IsDisposed) view.CoreWebView2.PostWebMessageAsJson(json.Serialize(new { kind = "updates-error", message = "Update could not be completed. No unverified installer was launched. Sign in and try again later." }));
        } finally {
            updateBusy = false;
            string pending = pendingUpdateAction; pendingUpdateAction = null;
            if (pending != null && !exiting && !IsDisposed) BeginInvoke((Action)(() => UpdateActionAsync(pending)));
        }
    }
    private async void SecurityActionAsync(string action) {
        if (securityBusy || busy || exiting || !Visible) return;
        securityBusy = true;
        try {
            var status = await NativeRequestAsync("/api/desktop/security", new { action = "status" });
            if (action == "security-status") {
                view.CoreWebView2.PostWebMessageAsJson(json.Serialize(new { kind = "security-state", requireDesktopPin = Convert.ToBoolean(status["requireDesktopPin"]) }));
            } else if (action == "security-lock") {
                await NativeRequestAsync("/api/desktop/security", new { action = "lock" });
                view.CoreWebView2.Navigate(origin + "/");
            } else if (action == "security-preference") {
                bool required = Convert.ToBoolean(status["requireDesktopPin"]);
                string message = required ? "Turn off PIN prompts in this native app? Anyone with access to this Windows account may open Rovarin. Phone and ordinary browser access will still require your canonical PIN." : "Require your Rovarin PIN on this PC again? You will be signed out now. Your phone uses the same PIN.";
                if (MessageBox.Show(this, message, "Require PIN on this PC", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2) != DialogResult.Yes) return;
                await NativeRequestAsync("/api/desktop/security", new { action = "preference", requireDesktopPin = !required, confirmed = true });
                view.CoreWebView2.PostWebMessageAsJson(json.Serialize(new { kind = "security-state", requireDesktopPin = !required }));
                if (!required) view.CoreWebView2.Navigate(origin + "/");
                else MessageBox.Show(this, "PIN prompts are off for this native app only. Lock still requires your PIN before automatic access resumes.", "Security", MessageBoxButtons.OK, MessageBoxIcon.Information);
            } else {
                if (MessageBox.Show(this, "Generate a new Rovarin PIN? This signs out every device. The new PIN will be used on this PC and other devices.", "Generate New PIN", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2) != DialogResult.Yes) return;
                var result = await NativeRequestAsync("/api/desktop/security", new { action = "rotate", confirmed = true });
                // Native dialog only: never inject the PIN/credential into frontend JS.
                MessageBox.Show(this, "Your new Rovarin PIN is:\n\n" + Convert.ToString(result["pin"]) + "\n\nUse this same PIN on all your devices. Your old PIN no longer works.", "New Rovarin PIN", MessageBoxButtons.OK, MessageBoxIcon.Information);
                view.CoreWebView2.Navigate(origin + "/");
            }
        } catch { MessageBox.Show(this, "Sign in with your Rovarin PIN, then try again. No security change was confirmed.", "Security", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
        finally { securityBusy = false; }
    }
    private bool maintenanceBusy;
    private Process maintenanceSetupProcess;
    private async Task<Dictionary<string, object>> InstallMaintenanceAsync() {
        // Only the fixed, build-bound Inno bootstrap is elevated. The service image
        // is never run from a writable preview/temp directory by this shell.
        using (var verified = DesktopShell.OpenMaintenanceSetup()) {
            string owner = WindowsIdentity.GetCurrent().User.Value;
            if (!System.Text.RegularExpressions.Regex.IsMatch(owner, @"^S-1-5-21-\d+-\d+-\d+-\d+$")) throw new IOException("Unsupported enrollment owner.");
            try {
                maintenanceSetupProcess = await Task.Run(() => Process.Start(new ProcessStartInfo {
                    FileName = DesktopShell.MaintenanceSetupPath, Arguments = "/OWNER=" + owner + " /NORESTART",
                    WorkingDirectory = Path.GetDirectoryName(DesktopShell.MaintenanceSetupPath), UseShellExecute = true, Verb = "runas"
                }));
            } catch (System.ComponentModel.Win32Exception error) {
                if (error.NativeErrorCode != 1223) throw;
                return new Dictionary<string, object> { { "state", "uac-cancelled" }, { "enabled", false } };
            }
            if (maintenanceSetupProcess == null || !await Task.Run(() => maintenanceSetupProcess.WaitForExit(600000)))
                return new Dictionary<string, object> { { "state", "provisioning-incomplete" }, { "enabled", false } };
            int code = maintenanceSetupProcess.ExitCode;
            maintenanceSetupProcess.Dispose(); maintenanceSetupProcess = null;
            var actual = await NativeRequestAsync("/api/desktop/maintenance", new { action = "status" });
            if (Convert.ToString(actual["state"]) == "enabled" && Convert.ToBoolean(actual["enabled"])) return actual;
            if (code == 2 || code == 5) return new Dictionary<string, object> { { "state", "uac-cancelled" }, { "enabled", false } };
            if (code != 0) return new Dictionary<string, object> { { "state", "setup-failed" }, { "enabled", false }, { "error", "Windows setup could not install administrator maintenance. Access was not enabled. Reopen Settings to check and retry." } };
            return actual; // Completion alone is never proof of owner enrollment.
        }
    }
    private async void MaintenanceActionAsync(string message) {
        if (maintenanceBusy || busy || exiting || loginPresentation || view == null) return;
        maintenanceBusy = true;
        try {
            await NativeRequestAsync("/api/desktop/security", new { action = "status" });
            string action = message == "maintenance-enable" ? "enable" : message == "maintenance-disable" ? "disable" : "status";
            Dictionary<string, object> result;
            if (maintenanceSetupProcess != null && !maintenanceSetupProcess.HasExited) {
                result = new Dictionary<string, object> { { "state", "provisioning-incomplete" }, { "enabled", false } };
            } else {
                if (maintenanceSetupProcess != null) { maintenanceSetupProcess.Dispose(); maintenanceSetupProcess = null; }
                result = await NativeRequestAsync("/api/desktop/maintenance", new { action = action });
                if (action == "enable" && Convert.ToString(result["state"]) == "not-installed") result = await InstallMaintenanceAsync();
            }
            // Availability is native-only and always revalidated before execution.
            if (Convert.ToString(result["state"]) == "not-installed" || Convert.ToString(result["state"]) == "uac-cancelled") {
                try { using (var verified = DesktopShell.OpenMaintenanceSetup()) result["canSetup"] = true; }
                catch (IOException) { result["canSetup"] = false; if (Convert.ToString(result["state"]) == "not-installed") result["error"] = "This Rovarin build is missing a verified maintenance installer. Repair or rebuild Rovarin to enable setup."; }
            }
            if (!exiting && view != null && !view.IsDisposed) {
                view.CoreWebView2.PostWebMessageAsJson(json.Serialize(new { kind = "maintenance-state", status = result }));
            }
        } catch (Exception error) {
            if (!exiting && view != null && !view.IsDisposed) {
                // Fixed messages only: no raw exception, credential or filesystem data.
                var webError = error as WebException;
                var response = webError == null ? null : webError.Response as HttpWebResponse;
                string detail = error is IOException ? "Maintenance setup failed its local safety checks. Repair or rebuild Rovarin; access was not enabled." :
                    response != null && response.StatusCode == HttpStatusCode.Conflict ? "Another system operation is active. Finish it, then reopen Settings." :
                    response != null && (response.StatusCode == HttpStatusCode.Unauthorized || response.StatusCode == HttpStatusCode.Forbidden) ? "Sign into the native Rovarin app again to manage administrator maintenance." :
                    "The desktop could not confirm maintenance status. Reopen Settings to retry.";
                if (response != null) response.Close();
                var err = new Dictionary<string, object> { { "state", "unavailable" }, { "enabled", false }, { "error", detail } };
                view.CoreWebView2.PostWebMessageAsJson(json.Serialize(new { kind = "maintenance-state", status = err }));
            }
        } finally {
            maintenanceBusy = false;
        }
    }
    private async Task StartAsync(bool restart) {
        if (busy || exiting) return;
        busy = true; loading = true;
        State("Opening Rovarin", "Starting or reusing your local server…", false, false);
        try {
            if (restart) await RunHelperAsync("stop.ps1", 20000);
            // First-run local Setup is interactive, so allow time to read/copy the PIN.
            var result = json.Deserialize<Dictionary<string, object>>(await RunHelperAsync("desktop-host.ps1", 600000));
            int port = Convert.ToInt32(result["port"]);
            if (!Convert.ToBoolean(result["ready"]) || port < 1 || port > 65535) throw new IOException("Local startup was not confirmed.");
            origin = "http://127.0.0.1:" + port;
            if (exiting || IsDisposed) return;
            await InitializeWebViewAsync();
            // A real native-only credential obtains an ordinary revocable session.
            // The default/locked state rejects it and shows the normal PIN page.
            try { await NativeRequestAsync("/api/desktop/auth", new { }); } catch { }
            view.CoreWebView2.Navigate(origin + "/");
        }
        catch (WebView2RuntimeNotFoundException) { State("Desktop runtime needed", "Install Microsoft WebView2, then try again. Your backend and phone access remain available.", true, true); }
        catch { if (!exiting && !IsDisposed) State("Couldn’t open Rovarin", "The local dashboard was not ready. Try again. No unrelated process was stopped.", true, false); }
        finally { busy = false; }
    }
    private async Task InitializeWebViewAsync() {
        if (initialized) return;
        DesktopShell.AssertPlain(DesktopShell.ProfileDirectory);
        view = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = recovery.BackColor, AllowExternalDrop = false };
        Controls.Add(view); recovery.BringToFront();
        desktopExit.BringToFront();
        desktopMinimize.BringToFront();
        try {
            var environment = await CoreWebView2Environment.CreateAsync(null, DesktopShell.ProfileDirectory);
            await view.EnsureCoreWebView2Async(environment);
            var core = view.CoreWebView2;
            // Native proof stays in C#: scoped to same-origin removal requests, never frontend JavaScript.
            core.AddWebResourceRequestedFilter(origin + "/api/apps/*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += delegate(object sender, CoreWebView2WebResourceRequestedEventArgs args) {
                Uri target;
                if (!Uri.TryCreate(args.Request.Uri, UriKind.Absolute, out target) || target.GetLeftPart(UriPartial.Authority) != origin) return;
                if (target.AbsolutePath != "/api/apps/removal-security" && target.AbsolutePath != "/api/apps/uninstall" && target.AbsolutePath != "/api/apps/leftovers/delete") return;
                if (!String.IsNullOrEmpty(desktopCredential) && desktopCredential.Length == 44) args.Request.Headers.SetHeader("X-PC-Monitor-Desktop", desktopCredential);
            };
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsBuiltInErrorPageEnabled = false;
            core.Settings.IsPasswordAutosaveEnabled = false;
            core.Settings.IsGeneralAutofillEnabled = false;
            core.Settings.IsWebMessageEnabled = true;
            core.Settings.AreHostObjectsAllowed = false;
            core.Settings.IsNonClientRegionSupportEnabled = true;
            // Presentation only; no auth/command bridge and no duplicate UI.
            await core.AddScriptToExecuteOnDocumentCreatedAsync("document.addEventListener('DOMContentLoaded',()=>{document.documentElement.classList.add('native-shell');const card=document.querySelector('.login-card');if(card){const drag=document.createElement('div');drag.className='lock-window-drag';drag.setAttribute('aria-hidden','true');const controls=document.createElement('div');controls.className='lock-window-controls';[['lock-window-minimize','−','Minimize Rovarin'],['lock-window-exit','×','Exit desktop app']].forEach(([action,glyph,label])=>{const button=document.createElement('button');button.type='button';button.id=action;button.textContent=glyph;button.title=label;button.setAttribute('aria-label',label);button.addEventListener('click',()=>chrome.webview.postMessage(action));controls.append(button)});card.prepend(drag,controls)}document.addEventListener('dragover',e=>e.preventDefault());document.addEventListener('drop',e=>e.preventDefault())},{once:true})");
            core.WebMessageReceived += delegate(object sender, CoreWebView2WebMessageReceivedEventArgs e) {
                if (!IsDashboardUri(e.Source, origin)) return;
                try {
                    string message = e.TryGetWebMessageAsString();
                    if (loginPresentation && message == "lock-window-minimize") { WindowState = FormWindowState.Minimized; return; }
                    if (loginPresentation && message == "lock-window-exit") { ExitShell(); return; }
                    if (message == "updates-status" || message == "updates-check" || message == "updates-automatic" || message == "updates-preference" || message == "updates-install" || message == "updates-notes") { UpdateActionAsync(message); return; }
                    if (message == "startup-status" || message == "startup-enable" || message == "startup-disable") { StartupActionAsync(message); return; }
                    if (message == "security-preference" || message == "security-rotate" || message == "security-status" || message == "security-lock") { SecurityActionAsync(message); return; }
                    if (message == "maintenance-status" || message == "maintenance-enable" || message == "maintenance-disable") { MaintenanceActionAsync(message); return; }
                    if (addressRequest != null) addressRequest.TrySetResult(message);
                } catch { }
            };
            core.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs e) {
                if (IsDashboardUri(e.Uri, origin)) return;
                e.Cancel = true; if (e.IsUserInitiated) External(e.Uri);
            };
            core.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs e) { e.Handled = true; if (e.IsUserInitiated) External(e.Uri); };
            core.PermissionRequested += delegate(object sender, CoreWebView2PermissionRequestedEventArgs e) { e.State = CoreWebView2PermissionState.Deny; };
            core.DownloadStarting += delegate(object sender, CoreWebView2DownloadStartingEventArgs e) { e.Cancel = true; };
            core.ProcessFailed += delegate { if (exiting || IsDisposed) return; State("Desktop view interrupted", "Try again to reopen the dashboard. Your backend remains available to other devices.", true, false); initialized = false; view.Dispose(); view = null; };
            core.NavigationCompleted += async delegate(object sender, CoreWebView2NavigationCompletedEventArgs e) {
                loading = false;
                if (e.IsSuccess) {
                    try {
                        // Read presentation only from the trusted local document.
                        if (!IsDashboardUri(core.Source, origin)) return;
                        string login = await core.ExecuteScriptAsync("!!document.getElementById('pinInput')");
                        if (exiting || IsDisposed) return;
                        ApplyLoginPresentation(login == "true");
                        if (login == "true") await FitLoginCardAsync(core);
                        recovery.Visible = false; LayoutRecovery(); QueueVisibility();
                        if (login != "true") {
                            UpdateActionAsync("updates-automatic");
                            if (updateTimer == null) {
                                updateTimer = new System.Windows.Forms.Timer { Interval = 86400000 };
                                updateTimer.Tick += delegate { UpdateActionAsync("updates-automatic"); };
                                updateTimer.Start();
                            }
                        }
                    } catch { if (!exiting && !IsDisposed) State("Dashboard unavailable", "Try again to reopen Rovarin.", true, false); }
                }
                else State("Dashboard unavailable", "The backend may have restarted. Try again to reopen Rovarin.", true, false);
            };
            initialized = true;
        } catch { view.Dispose(); view = null; throw; }
    }
    private async void QueueVisibility() {
        if (!initialized || view == null || loading || visibilityPending || exiting) return;
        visibilityPending = true;
        try {
            bool active;
            do {
                active = Visible && WindowState != FormWindowState.Minimized;
                await SetClientVisibilityAsync(active);
            } while (active != (Visible && WindowState != FormWindowState.Minimized) && !exiting && !IsDisposed);
        } catch { } finally { visibilityPending = false; }
    }
    private async Task SetClientVisibilityAsync(bool active) {
        if (view == null || view.IsDisposed || IsDisposed) return;
        if (active) view.Visible = true;
        view.CoreWebView2.Resume();
        if (active) await Task.Delay(50);
        if (view == null || view.IsDisposed || IsDisposed) return;
        // Fixed client event invokes the SAME frontend lease lifecycle as the web.
        await view.CoreWebView2.ExecuteScriptAsync("window.dispatchEvent(new CustomEvent('pc-monitor-desktop-visibility',{detail:{visible:" + (active ? "true" : "false") + "}}))");
        if (view == null || view.IsDisposed || IsDisposed) return;
        view.Visible = active;
        // Let the existing release beacon finish. Hidden clients have no lease,
        // SSE or fallback/maintenance polling; don't block reopen on Chromium's
        // optional suspension operation (which can wait on outstanding work).
        if (!active) await Task.Delay(200);
    }
    private static void External(string address) {
        Uri uri;
        if (!Uri.TryCreate(address, UriKind.Absolute, out uri) || (uri.Scheme != "https" && uri.Scheme != "http") || !String.IsNullOrEmpty(uri.UserInfo)) return;
        try { Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true }); } catch { }
    }
    private async Task CopyAddressAsync() {
        if (origin == null || addressRequest != null) return;
        string address = null;
        try {
            if (initialized && view != null) {
                // User-triggered, same-origin authenticated existing diagnostics. No cookie extraction.
                view.CoreWebView2.Resume();
                addressRequest = new TaskCompletionSource<string>();
                await view.CoreWebView2.ExecuteScriptAsync("void(async()=>{let a='';try{const r=await fetch('/api/diagnostics');if(r.ok){const d=await r.json(),c=d.checks||[];if(c.find(x=>x.id==='tailscale-status')?.value==='Running')a=c.find(x=>x.id==='tailscale-ip')?.value||''}}catch{}chrome.webview.postMessage(a)})()");
                var completed = await Task.WhenAny(addressRequest.Task, Task.Delay(5000));
                string candidate = completed == addressRequest.Task ? addressRequest.Task.Result : "";
                System.Net.IPAddress ip; byte[] bytes;
                if (System.Net.IPAddress.TryParse(candidate, out ip) && (bytes = ip.GetAddressBytes()).Length == 4 && bytes[0] == 100 && bytes[1] >= 64 && bytes[1] <= 127)
                    address = "http://" + ip + ":" + new Uri(origin).Port;
            }
        } catch { } finally { addressRequest = null; }
        try {
            if (address == null) tray.ShowBalloonTip(2500, "Mobile address unavailable", "Log in to Rovarin and connect Tailscale, then try again. Your clipboard was not changed.", ToolTipIcon.Info);
            else { Clipboard.SetText(address); tray.ShowBalloonTip(2500, "Mobile address copied", "Connect your phone to Tailscale and enter your Rovarin PIN.", ToolTipIcon.Info); }
        } catch { }
        QueueVisibility();
    }
    private void RestoreBoundsFromDisk() {
        try {
            DesktopShell.AssertPlain(DesktopShell.DataDirectory);
            string file = Path.Combine(DesktopShell.DataDirectory, "desktop-window.json");
            if (!File.Exists(file) || new FileInfo(file).Length > 1024 || (File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) return;
            var value = json.Deserialize<Dictionary<string, int>>(File.ReadAllText(file));
            var area = Screen.PrimaryScreen.WorkingArea;
            // Migrate the old untouched default; retain deliberate custom sizes.
            bool oldDefault = value["width"] == 980 && value["height"] == 740;
            int width = Math.Min(area.Width, Math.Max(760, oldDefault ? 900 : value["width"])), height = Math.Min(area.Height, Math.Max(560, oldDefault ? 680 : value["height"]));
            var saved = new Rectangle(value["x"], value["y"], width, height);
            foreach (var screen in Screen.AllScreens) if (screen.WorkingArea.Contains(saved)) { Bounds = saved; StartPosition = FormStartPosition.Manual; break; }
            if (value["maximized"] == 1) WindowState = FormWindowState.Maximized;
        } catch { }
    }
    private void SaveBounds() {
        try {
            DesktopShell.AssertPlain(DesktopShell.DataDirectory);
            Directory.CreateDirectory(DesktopShell.DataDirectory);
            var file = Path.Combine(DesktopShell.DataDirectory, "desktop-window.json");
            if (File.Exists(file) && (File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) return;
            var temp = file + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try {
                using (var stream = new FileStream(temp, FileMode.CreateNew, FileAccess.Write))
                using (var writer = new StreamWriter(stream)) writer.Write(json.Serialize(new { x = normalBounds.X, y = normalBounds.Y, width = normalBounds.Width, height = normalBounds.Height, maximized = wasMaximized ? 1 : 0 }));
                if (File.Exists(file)) File.Replace(temp, file, null); else File.Move(temp, file);
            } finally { if (File.Exists(temp)) File.Delete(temp); }
        } catch { }
    }
}
