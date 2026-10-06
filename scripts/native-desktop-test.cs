// Test-only harness; never included in the installer. Exercises the exact
// packaged Form/WebView2 and real authenticated frontend in an owned fixture.
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
internal static class NativeDesktopTest
{
    static Form form; static Type window; static string origin; static int result = 1;
    static BindingFlags flags = BindingFlags.Instance | BindingFlags.NonPublic;
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hwnd,int message,IntPtr wparam,IntPtr lparam);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd,int message,IntPtr wparam,IntPtr lparam);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd,int attribute,out int value,int size);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hwnd,int index);
    static WebView2 View { get { return (WebView2)window.GetField("view", flags).GetValue(form); } }
    static void Check(bool test, string message) { if (!test) throw new Exception(message); }
    static void Invoke(string method) { window.GetMethod(method, flags).Invoke(form, null); }
    static async Task<bool> Condition(string script) {
        try { return await View.CoreWebView2.ExecuteScriptAsync(script) == "true"; } catch { return false; }
    }
    static async Task Wait(string script, string label, int seconds = 12) {
        var limit = DateTime.UtcNow.AddSeconds(seconds);
        while (DateTime.UtcNow < limit) { if (await Condition(script)) return; await Task.Delay(100); }
        if(label.StartsWith("Native installed-app")) Console.Error.WriteLine(await View.CoreWebView2.ExecuteScriptAsync("JSON.stringify({rows:document.querySelectorAll('.apps-row').length,status:document.getElementById('appsStatus')?.textContent,width:document.documentElement.scrollWidth,viewport:innerWidth})"));
        throw new Exception(label + "; pending=" + window.GetField("visibilityPending",flags).GetValue(form) + "; loading=" + window.GetField("loading",flags).GetValue(form) + "; visible=" + form.Visible + "; doc=" + await View.CoreWebView2.ExecuteScriptAsync("document.visibilityState"));
    }
    static async Task<int> Leases() {
        // ExecuteScript doesn't await promises. Use a test-only fixed scratch value.
        await View.CoreWebView2.ExecuteScriptAsync("window.__qaLeases=null;void fetch('/api/monitoring/status').then(r=>r.json()).then(x=>window.__qaLeases=x.leaseCount)");
        await Wait("Number.isInteger(window.__qaLeases)", "Status read failed");
        return Int32.Parse(await View.CoreWebView2.ExecuteScriptAsync("window.__qaLeases"));
    }
    static async Task WaitLeases(bool active) {
        var limit = DateTime.UtcNow.AddSeconds(12);
        while (DateTime.UtcNow < limit) {
            View.CoreWebView2.Resume();
            if ((await Leases() > 0) == active) return;
            await Task.Delay(200);
        }
        throw new Exception((active ? "Lease did not recover" : "Hidden window retained lease") + "; count=" + await Leases() + "; state=" + await View.CoreWebView2.ExecuteScriptAsync("JSON.stringify({lease:window.monitoringLeaseId,visible:dashboardClientVisible(),profile:desiredMonitoringProfile})"));
    }
    [STAThread] static int Main() {
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        var assembly = Assembly.LoadFrom(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"Rovarin.exe"));
        window = assembly.GetType("DesktopWindow");
        form = (Form)Activator.CreateInstance(window, true);
        var json = new JavaScriptSerializer();
        var package = json.Deserialize<System.Collections.Generic.Dictionary<string,object>>(File.ReadAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"package.json")));
        string currentVersion = json.Serialize((string)package["version"]);
        var saved = json.Deserialize<System.Collections.Generic.Dictionary<string,object>>(File.ReadAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"..","data","config.json")));
        string pin = (string)saved["pin"];
        form.Shown += async delegate {
            try {
                var deadline=DateTime.UtcNow.AddSeconds(45);
                while((View==null || View.CoreWebView2==null) && DateTime.UtcNow<deadline) await Task.Delay(100);
                Check(View!=null && View.CoreWebView2!=null,"WebView2 did not initialize");
                origin=(string)window.GetField("origin",flags).GetValue(form);
                await Wait("location.origin==="+json.Serialize(origin)+" && document.readyState==='complete'", "Login document not ready");
                Check(View.CoreWebView2.Source.StartsWith(origin),"Wrong dashboard origin");
                await View.CoreWebView2.ExecuteScriptAsync("window.__qaAuth=null;void fetch('/api/metrics').then(r=>window.__qaAuth=r.status)");
                await Wait("window.__qaAuth===401", "Native shell bypassed authentication");
                await Task.Delay(200);
                Check(form.Width==360 && form.Height>=320 && form.Height<480,"PIN window not sized around the shared card");
                Check(form.FormBorderStyle==FormBorderStyle.None && !form.ControlBox && form.ClientSize==form.Size,"Lock window has an outer native frame");
                bool dwmCorners=(bool)window.GetField("lockUsesDwmCorners",flags).GetValue(form);
                if(dwmCorners) {
                    int corners,policy;
                    Check(form.Region==null && DwmGetWindowAttribute(form.Handle,33,out corners,4)==0 && corners==2 && DwmGetWindowAttribute(form.Handle,1,out policy,4)==0 && policy==1,"Smooth native DWM corners/frame policy missing");
                } else Check(form.Region!=null && !form.Region.IsVisible(0,0) && form.Region.IsVisible(form.Width/2,form.Height/2),"Safe rounded fallback missing");
                await Wait("document.querySelectorAll('.lock-window-controls button').length===2 && document.getElementById('lock-window-minimize').getAttribute('aria-label')==='Minimize Rovarin' && document.getElementById('lock-window-exit').getAttribute('aria-label')==='Exit desktop app' && getComputedStyle(document.querySelector('.lock-window-drag')).getPropertyValue('app-region')==='drag' && ['pinInput','unlockBtn','errMsg','lock-window-minimize','lock-window-exit'].every(id=>getComputedStyle(document.getElementById(id)).getPropertyValue('app-region')==='no-drag')", "Integrated lock controls/drag exclusions missing");
                await Wait("!document.querySelector('.lock-window-controls button[aria-label*=Maximize]') && (()=>{const c=document.querySelector('.lock-window-controls').getBoundingClientRect(),i=document.querySelector('.login-icon').getBoundingClientRect();return c.left>=i.right && c.right<=innerWidth-12})()", "Lock controls overlap icon or add maximize");
                SendMessage(form.Handle,0xA3,new IntPtr(2),IntPtr.Zero);
                SendMessage(form.Handle,0x112,new IntPtr(0xF030),IntPtr.Zero);
                Check(form.WindowState==FormWindowState.Normal,"Locked drag double click/system action maximized window");
                // Navigation sizes the card asynchronously. Begin interaction
                // only once its measured native client bounds are ready.
                await Wait("(()=>{const r=document.querySelector('.login-card').getBoundingClientRect();return Math.abs(r.top)<1 && Math.abs(r.bottom-innerHeight)<2})()", "Measured lock window not ready for interaction");
                var centeredLockBounds=form.Bounds;
                IntPtr moveHandle=form.Handle;
                var moveKeys=Task.Run(async delegate {
                    await Task.Delay(150);PostMessage(moveHandle,0x100,new IntPtr(0x27),IntPtr.Zero);
                    await Task.Delay(50);PostMessage(moveHandle,0x100,new IntPtr(0x28),IntPtr.Zero);
                    await Task.Delay(50);PostMessage(moveHandle,0x100,new IntPtr(0x0D),IntPtr.Zero);
                    await Task.Delay(800);PostMessage(moveHandle,0x100,new IntPtr(0x1B),IntPtr.Zero);
                });
                SendMessage(form.Handle,0x112,new IntPtr(0xF010),IntPtr.Zero);
                await moveKeys;
                Check(form.Location!=centeredLockBounds.Location && form.Size==centeredLockBounds.Size,"Native system move did not move compact window");
                var movedLockBounds=form.Bounds;
                Check((GetWindowLong(form.Handle,-16)&0x40000)==0,"Locked window retained WS_THICKFRAME");
                for(int restoreCycle=0;restoreCycle<5;restoreCycle++) {
                    await View.CoreWebView2.ExecuteScriptAsync("document.getElementById('lock-window-minimize').click()");
                    await Task.Delay(300);Check(form.WindowState==FormWindowState.Minimized,"Integrated lock minimize did not minimize actual window");
                    Invoke("OpenWindow");await Task.Delay(300);
                    Check(form.Bounds==movedLockBounds && form.WindowState==FormWindowState.Normal,"Minimize/reopen changed lock bounds: before="+movedLockBounds+" after="+form.Bounds+" state="+form.WindowState);
                    Check(form.ClientSize==movedLockBounds.Size,"Locked client dimensions changed after restore");
                }
                Console.WriteLine("PASS five minimize/restore cycles: "+movedLockBounds.Width+"x"+movedLockBounds.Height+" unchanged, including moved position and client bounds");
                Invoke("SaveBounds");
                var lockedSaved=json.Deserialize<System.Collections.Generic.Dictionary<string,int>>(File.ReadAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"..","data","desktop-window.json")));
                Check(lockedSaved["width"]==900 && lockedSaved["height"]==680 && lockedSaved["x"]!=movedLockBounds.X,"Moved lock bounds contaminated saved normal bounds");
                Console.WriteLine("PASS desktop integrated controls, native move, drag/input exclusions, maximize guard, minimize/restore position and saved bounds; corner mode="+(dwmCorners?"Windows 11 DWM":"rounded fallback"));
                Check(!((Button)window.GetField("desktopExit",flags).GetValue(form)).Visible && !((Button)window.GetField("desktopMinimize",flags).GetValue(form)).Visible,"Lock window shows native caption controls");
                Check(View.Bounds==form.ClientRectangle,"Locked WebView does not fill the native client area");
                await Wait("!document.querySelector('.native-app-bar') && (()=>{const r=document.querySelector('.login-card').getBoundingClientRect();return Math.abs(r.top)<1 && Math.abs(r.bottom-innerHeight)<2 && r.left===0 && r.right===innerWidth})()", "Outer background/padding remains around native lock card");
                using(var image=File.Create(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"native-lock.png"))) await View.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,image);
                await Wait("document.documentElement.scrollHeight<=innerHeight+1", "Compact PIN page overflows");
                await View.CoreWebView2.CallDevToolsProtocolMethodAsync("Emulation.setEmulatedMedia", "{\"features\":[{\"name\":\"prefers-reduced-motion\",\"value\":\"no-preference\"},{\"name\":\"prefers-contrast\",\"value\":\"no-preference\"}]}");
                var loginSize=form.Size; var loginMinimum=form.MinimumSize;
                form.MinimumSize=new System.Drawing.Size(320,240);
                await View.CoreWebView2.ExecuteScriptAsync("document.documentElement.classList.remove('native-shell');document.querySelector('.login-container').style.paddingTop='47px';document.querySelector('.login-container').style.paddingBottom='34px';window.dispatchEvent(new Event('resize'))");
                foreach(var phoneSize in new System.Drawing.Size[]{new System.Drawing.Size(320,568),new System.Drawing.Size(375,812),new System.Drawing.Size(390,844),new System.Drawing.Size(430,932)}) {
                    int width=phoneSize.Width; form.Size=phoneSize;
                    await Wait("innerWidth==="+width+" && document.documentElement.scrollWidth<=innerWidth && getComputedStyle(document.querySelector('.login-container')).justifyContent==='center' && getComputedStyle(document.querySelector('.login-container')).overflowY==='hidden' && getComputedStyle(document.querySelector('.lock-window-controls')).display==='none' && getComputedStyle(document.querySelector('.lock-window-drag')).display==='none'", "Stable phone PIN layout at "+width);
                    await Wait("!document.getElementById('pinInput').autofocus && (matchMedia('(prefers-reduced-motion: reduce)').matches ? getComputedStyle(document.querySelector('.pin-input')).transitionDuration==='0s' : getComputedStyle(document.querySelector('.pin-input')).transitionProperty==='border-color, box-shadow') && parseFloat(getComputedStyle(document.querySelector('.pin-input')).letterSpacing)<=6", "Phone PIN keyboard/animation settings at "+width);
                    await View.CoreWebView2.ExecuteScriptAsync("(()=>{const p=document.getElementById('pinInput');p.focus();window.__qaPinTop=p.getBoundingClientRect().top;for(const d of '123456'){p.value+=d;p.dispatchEvent(new Event('input',{bubbles:true}));}window.__qaTyped=p.value==='123456' && p.getBoundingClientRect().top===window.__qaPinTop;window.__qaAuto=window.__qaAuto||document.getElementById('unlockBtn').disabled;p.value='';p.blur()})()");
                    await Wait("window.__qaTyped && window.__qaAuto && document.documentElement.scrollWidth<=innerWidth", "Phone PIN typing shifted/cleared or did not auto-submit at "+width);
                    await Wait("(()=>{const c=document.querySelector('.login-container'),r=document.querySelector('.login-card').getBoundingClientRect(),p=getComputedStyle(c);return r.top>=47 && r.bottom<=innerHeight-34 && Math.abs((r.top+r.bottom)/2-(47+(innerHeight-47-34)/2))<2})()", "Phone login is not centered within safe areas at "+width);
                    await View.CoreWebView2.ExecuteScriptAsync("scrollTo(0,200);document.querySelector('.login-container').scrollTop=200");
                    await Wait("scrollY===0 && document.body.scrollTop===0 && document.querySelector('.login-container').scrollTop===0", "Phone login scroll lock failed at "+width);
                    if(width==390) using(var image=File.Create(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"login-mobile.png"))) await View.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,image);
                    form.Height=320;
                    await Wait("innerHeight===320 && (()=>{const p=document.getElementById('pinInput').getBoundingClientRect(),b=document.getElementById('unlockBtn').getBoundingClientRect();return p.top>=47 && b.bottom<=innerHeight-34 && b.height>=44 && scrollY===0})()", "Keyboard-height PIN and unlock button hidden at "+width);
                    await View.CoreWebView2.ExecuteScriptAsync("document.getElementById('errMsg').textContent='Incorrect PIN. Please try again.'");
                    await Wait("document.getElementById('errMsg').getBoundingClientRect().bottom<=innerHeight-34", "Keyboard-height error clipped at "+width);
                    if(width==390) using(var image=File.Create(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"login-keyboard.png"))) await View.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,image);
                    await View.CoreWebView2.ExecuteScriptAsync("document.getElementById('errMsg').textContent=''");
                }
                form.MinimumSize=loginMinimum;form.Size=loginSize;
                await View.CoreWebView2.ExecuteScriptAsync("document.querySelector('.login-container').style.removeProperty('padding-top');document.querySelector('.login-container').style.removeProperty('padding-bottom');document.documentElement.classList.add('native-shell');window.dispatchEvent(new Event('resize'))");
                Console.WriteLine("PASS phone PIN 320x568/375x812/390x844/430x932: safe-area centered, no page/pane scrolling, stable typing; reduced-height 320px controls/errors visible (physical iOS keyboard remains manual)");
                await View.CoreWebView2.ExecuteScriptAsync("window.__qaLogin=null;void fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin:"+json.Serialize(pin)+"})}).then(r=>window.__qaLogin=r.status)");
                await Wait("window.__qaLogin===200", "Native PIN login failed");
                View.CoreWebView2.Navigate(origin+"/");
                await Wait("document.readyState==='complete' && !!window.monitoringLeaseId", "Dashboard did not acquire lease",30);
                await WaitLeases(true);
                Check(form.Region==null && form.Size==new System.Drawing.Size(900,680),"Unlock did not restore normal window bounds/outline");
                Check(form.Padding.Left>=5 && View.Left>=form.Padding.Left && View.Right<=form.ClientSize.Width-form.Padding.Right,"WebView covers native resize edges");
                var resizePoint=form.PointToScreen(new System.Drawing.Point(2,form.ClientSize.Height/2));
                var resizeHit=SendMessage(form.Handle,0x84,IntPtr.Zero,new IntPtr((resizePoint.Y<<16)|(resizePoint.X&0xffff)));
                Check(resizeHit.ToInt32()==10,"Authenticated left edge is not a native resize target");
                await Wait("!document.documentElement.classList.contains('login-page') && !document.documentElement.style.getPropertyValue('--login-viewport-height')", "Login-only scroll styles leaked into dashboard");
                await Wait("eventSource?.readyState===1", "Native SSE did not connect");
                Console.WriteLine("PASS native dashboard/authentication ready");
                await View.CoreWebView2.ExecuteScriptAsync("chrome.webview.postMessage('lock-window-minimize')");
                await Task.Delay(150);Check(form.WindowState==FormWindowState.Normal,"Locked-only message affected authenticated desktop");
                Check(form.FormBorderStyle==FormBorderStyle.None && !form.ControlBox,"Windows caption/control box remains");
                Check((GetWindowLong(form.Handle,-16)&0xC00000)==0,"Windows caption style remains");
                Check(form.ClientSize==form.Size,"Native UI does not reach window edges");
                Check(View.Bounds==new System.Drawing.Rectangle(form.Padding.Left,form.Padding.Top,form.ClientSize.Width-form.Padding.Horizontal,form.ClientSize.Height-form.Padding.Vertical),"WebView does not fill the authenticated area inside native resize edges");
                Check(View.CoreWebView2.Settings.IsNonClientRegionSupportEnabled && !View.AllowExternalDrop,"Native drag/drop settings incorrect");
                await Wait("document.documentElement.classList.contains('native-shell') && getComputedStyle(document.querySelector('.native-app-bar')).display==='flex' && document.querySelector('.native-app-bar').getBoundingClientRect().top===0", "Integrated native bar missing");
                await Wait("getComputedStyle(document.querySelector('.native-app-bar')).getPropertyValue('app-region')==='drag' && getComputedStyle(document.getElementById('nativeSettingsButton')).getPropertyValue('app-region')==='no-drag'", "Native drag region/settings hit target incorrect");
                await Wait("getComputedStyle(document.documentElement).scrollbarWidth==='none' && getComputedStyle(document.body).scrollbarWidth==='none'", "Visual scrollbar not hidden");
                await Wait("!document.querySelector('.live-pill') && !document.querySelector('.header-bar') && !!document.getElementById('logoutButton').closest('#securitySettingsPanel') && !!document.getElementById('nativeSettingsButton').closest('#appSidebar') && !document.querySelector('.native-app-bar #nativeSettingsButton')", "Sidebar Settings/security placement incorrect");
                await View.CoreWebView2.ExecuteScriptAsync("setSidebarOpen(false);document.getElementById('sidebarToggle').click()");
                await Wait("document.body.classList.contains('sidebar-expanded') && localStorage.getItem('pc-monitor-sidebar-expanded')==='true' && getComputedStyle(document.querySelector('.app-sidebar span')).display!=='none'", "Desktop sidebar did not expand/persist");
                await View.CoreWebView2.ExecuteScriptAsync("document.getElementById('sidebarToggle').click()");
                await Wait("!document.body.classList.contains('sidebar-expanded') && localStorage.getItem('pc-monitor-sidebar-expanded')==='false'", "Desktop sidebar did not collapse/persist");
                await View.CoreWebView2.ExecuteScriptAsync("document.querySelector('[data-page=maintenancePage]').click()");
                await Wait("!document.getElementById('maintenancePage').hidden && document.querySelectorAll('#maintenanceMount .maint-action-card').length>0", "Maintenance sidebar navigation/actions missing");
                await View.CoreWebView2.ExecuteScriptAsync("document.querySelector('[data-page=dashboardPage]').click()");
                await View.CoreWebView2.ExecuteScriptAsync("document.querySelector('.host-details').open=true;scrollTo(0,160)");
                await Wait("scrollY>0", "Normal document scrolling was disabled");
                await View.CoreWebView2.ExecuteScriptAsync("document.querySelector('.host-details').open=false;scrollTo(0,0);document.getElementById('nativeSettingsButton').click()");
                await Wait("!document.getElementById('diagnosticsPage').hidden && document.activeElement.id==='monitorSettings'", "Settings did not reuse existing preferences");
                await Wait("!document.getElementById('copyDiagnostics').disabled", "Diagnostics not ready");
                // Local UI fixtures only: never download/install a driver or alter Tailscale.
                await View.CoreWebView2.ExecuteScriptAsync("window.__qaOriginalFetch=fetch;window.__qaInstalls=0;window.__qaSupport={localDesktop:true,bundled:false,driverInstalled:false,installing:false,sensor:'unavailable'};window.__qaReport=null;void fetch('/api/diagnostics').then(r=>r.json()).then(d=>{window.__qaReport=d;d.checks=d.checks.map(c=>c.id==='tailscale'?{...c,status:'unavailable'}:c);window.fetch=(u,o)=>String(u)==='/api/temperature/enhanced'?Promise.resolve(new Response(JSON.stringify(window.__qaSupport))):String(u).startsWith('/api/diagnostics')?Promise.resolve(new Response(JSON.stringify(window.__qaReport))):String(u)==='/api/temperature/enhanced/install'?(window.__qaInstalls++,Promise.resolve(new Response(JSON.stringify({success:false,code:'cancelled',error:'Cancelled in fixture'})))):window.__qaOriginalFetch(u,o);document.getElementById('refreshDiagnostics').click()})");
                await Wait("!!document.querySelector('[data-enhanced-actions] a[href=\"https://github.com/namazso/PawnIO.Setup/releases/download/2.2.0/PawnIO_setup.exe\"]') && !!document.querySelector('a[href=\"https://tailscale.com/download/windows\"]')", "Missing tools need official download actions");
                await View.CoreWebView2.ExecuteScriptAsync("window.__qaSupport.bundled=true;document.getElementById('refreshDiagnostics').click()");
                await Wait("[...document.querySelectorAll('[data-enhanced-actions] button')].some(b=>b.textContent==='Install PawnIO'&&!b.disabled) && !document.querySelector('[data-enhanced-actions] a')", "Bundled PawnIO must reuse installation action");
                await View.CoreWebView2.ExecuteScriptAsync("window.__qaConfirm=confirm;window.confirm=()=>false;[...document.querySelectorAll('[data-enhanced-actions] button')].find(b=>b.textContent==='Install PawnIO').click()");
                await Wait("window.__qaInstalls===0", "Cancelled confirmation started an installer");
                await View.CoreWebView2.ExecuteScriptAsync("window.confirm=()=>true;[...document.querySelectorAll('[data-enhanced-actions] button')].find(b=>b.textContent==='Install PawnIO').click();window.confirm=window.__qaConfirm");
                await Wait("window.__qaInstalls===1 && !document.getElementById('installEnhancedSupport').disabled", "Fixture install did not finish/re-enable");
                await View.CoreWebView2.ExecuteScriptAsync("window.__qaSupport.driverInstalled=true;document.getElementById('refreshDiagnostics').click()");
                await Wait("!document.querySelector('[data-enhanced-actions] a') && ![...document.querySelectorAll('[data-enhanced-actions] button')].some(b=>b.textContent==='Install PawnIO')", "Installed driver should not offer a speculative reinstall");
                await View.CoreWebView2.ExecuteScriptAsync("window.__qaSupport.localDesktop=false;document.getElementById('refreshDiagnostics').click()");
                await Wait("!document.querySelector('[data-enhanced-actions]').children.length", "Remote client must not offer driver installation/download");
                await View.CoreWebView2.ExecuteScriptAsync("window.fetch=window.__qaOriginalFetch;document.getElementById('refreshDiagnostics').click()");
                Console.WriteLine("PASS Diagnostics official missing-tool downloads, existing confirmed installer action, cancelled confirmation, installed-driver and remote-client guards (mocked; no driver installed)");
                await View.CoreWebView2.ExecuteScriptAsync("document.getElementById('updatesSettingsTab').click()");
                await Wait("!document.getElementById('updatesSettingsPanel').hidden && document.getElementById('updateCurrentVersion').textContent===" + currentVersion + " && !document.getElementById('nativeUpdateControls').hidden && !document.getElementById('autoCheckUpdates').disabled && !document.getElementById('autoCheckUpdates').checked", "Native Updates status/preference unavailable");
                await View.CoreWebView2.ExecuteScriptAsync("window.chrome.webview.postMessage('updates-preference')");
                await Wait("document.getElementById('autoCheckUpdates').checked", "Native update preference did not persist");
                await View.CoreWebView2.ExecuteScriptAsync("window.chrome.webview.postMessage('updates-preference')");
                await Wait("!document.getElementById('autoCheckUpdates').checked", "Native update preference could not disable checking");
                await View.CoreWebView2.ExecuteScriptAsync("renderUpdateStatus({currentVersion:'0.1.1',latestVersion:'0.1.2',available:true,autoCheck:false,installed:true,message:'Test fixture: update available',releaseNotes:'Disposable UI fixture',releaseUrl:'https://github.com/DontMovePlease/Rovarin/releases/tag/v0.1.2'});document.getElementById('updateLater').click()");
                await Wait("document.getElementById('installUpdate').hidden && document.getElementById('updateLater').hidden && document.getElementById('updateStatus').textContent.includes('when ready')", "Later did not dismiss the update offer");
                Console.WriteLine("PASS native Updates current version, authenticated bridge, persistent auto preference and Later (no installer executed)");
                await View.CoreWebView2.ExecuteScriptAsync("document.getElementById('securitySettingsTab').click()");
                await Wait("!document.getElementById('securitySettingsPanel').hidden && !document.getElementById('nativeSecurityControls').hidden && !document.getElementById('desktopPinPreference').disabled && document.getElementById('desktopPinPreference').checked", "Native Security did not load authenticated default preference");
                await View.CoreWebView2.ExecuteScriptAsync("document.getElementById('generalSettingsTab').click()");
                // Fixture only: exercise actual native credential -> HttpOnly cookie
                // provisioning, not merely the API or a frontend/class flag.
                var nativeRequest = window.GetMethod("NativeRequestAsync", flags);
                var preferenceOff = (Task<System.Collections.Generic.Dictionary<string,object>>)nativeRequest.Invoke(form, new object[] { "/api/desktop/security", new { action="preference", requireDesktopPin=false, confirmed=true } });
                await preferenceOff;
                await View.CoreWebView2.ExecuteScriptAsync("window.__qaReleased=false;void releaseMonitoringLease().then(()=>window.__qaReleased=true)");
                await Wait("window.__qaReleased===true", "Pre-auto-login lease release failed");
                View.CoreWebView2.CookieManager.DeleteAllCookies();
                await (Task)window.GetMethod("StartAsync", flags).Invoke(form,new object[] { false });
                await Wait("document.readyState==='complete' && !!window.monitoringLeaseId && !!document.getElementById('dashboardPage')", "Trusted native optional auto-login failed",30);
                var preferenceOn = (Task<System.Collections.Generic.Dictionary<string,object>>)nativeRequest.Invoke(form, new object[] { "/api/desktop/security", new { action="preference", requireDesktopPin=true, confirmed=true } });
                await preferenceOn;
                View.CoreWebView2.Navigate(origin+"/");
                await Wait("document.readyState==='complete' && !!document.getElementById('pinInput')", "Re-enabled native PIN did not show login");
                await Task.Delay(200); Check(form.Width==360 && form.Height<480 && ((bool)window.GetField("lockUsesDwmCorners",flags).GetValue(form) || form.Region!=null),"Lock/re-enable did not return to rounded compact PIN window");
                Invoke("SaveBounds");
                var normalSaved=json.Deserialize<System.Collections.Generic.Dictionary<string,int>>(File.ReadAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"..","data","desktop-window.json")));
                Check(normalSaved["width"]==900 && normalSaved["height"]==680,"Locked bounds overwrote normal authenticated saved bounds");
                await View.CoreWebView2.ExecuteScriptAsync("window.__qaLogin=null;void fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin:"+json.Serialize(pin)+"})}).then(r=>window.__qaLogin=r.status)");
                await Wait("window.__qaLogin===200", "Canonical PIN failed after re-enable");
                View.CoreWebView2.Navigate(origin+"/");
                await Wait("document.readyState==='complete' && !!window.monitoringLeaseId", "Dashboard did not return after re-enable",30);
                await View.CoreWebView2.ExecuteScriptAsync("document.getElementById('nativeSettingsButton').click()");
                Console.WriteLine("PASS actual native passwordless cookie provisioning and PIN re-enable");
                await View.CoreWebView2.ExecuteScriptAsync("document.getElementById('nativeBackButton').click()");
                await Wait("!document.getElementById('dashboardPage').hidden && !document.getElementById('nativeForwardButton').disabled", "Back did not return to dashboard");
                await View.CoreWebView2.ExecuteScriptAsync("document.getElementById('nativeForwardButton').click()");
                await Wait("!document.getElementById('diagnosticsPage').hidden", "Forward did not restore settings page");
                await View.CoreWebView2.ExecuteScriptAsync("document.getElementById('nativeBackButton').click();showAppPage('processesPage')");
                await Wait("document.getElementById('nativeForwardButton').disabled", "New navigation did not discard forward history");
                await View.CoreWebView2.ExecuteScriptAsync("document.querySelector('[data-page=dashboardPage]').click();scrollTo(0,0)");
                Console.WriteLine("PASS page Back/Forward, branch history and Settings navigation");
                await View.CoreWebView2.ExecuteScriptAsync("showAppPage('appsPage')");
                await Wait("!appsPage.hidden && document.querySelectorAll('.apps-row').length>0 && document.documentElement.scrollWidth<=innerWidth", "Native installed-app inventory and page navigation",45);
                await View.CoreWebView2.ExecuteScriptAsync("window.__qaAppIds=Array.from(document.querySelectorAll('.apps-row')).slice(0,3).map(r=>({id:r.dataset.appId,name:r.querySelector('h2').textContent}));for(const app of __qaAppIds){appsSearch.value=app.name;appsSearch.dispatchEvent(new Event('input'));const row=Array.from(document.querySelectorAll('.apps-row')).find(r=>r.dataset.appId===app.id);const check=row.querySelector('input');check.checked=true;check.dispatchEvent(new Event('change'));}appsSearch.value='qa-no-match';appsSearch.dispatchEvent(new Event('input'));appsBatchUninstall.click()");
                await Wait("appsConfirmDialog.open && document.querySelectorAll('#appsConfirmList li').length===3 && appsSelectedCount.textContent==='3 selected'", "Real inventory hidden selections must survive searches and reach review");
                await View.CoreWebView2.ExecuteScriptAsync("document.querySelector('#appsConfirmList button.apps-review-remove').click();appsConfirmCancel.click();appsSearch.value='';appsSearch.dispatchEvent(new Event('input'))");
                await Wait("appsSelectedCount.textContent==='2 selected' && document.querySelectorAll('.apps-row.is-selected').length===2", "Real review removal/cancel must preserve remaining selections");
                await View.CoreWebView2.ExecuteScriptAsync("appsClearSelection.click()");
                await View.CoreWebView2.ExecuteScriptAsync("document.querySelector('.apps-row button:not(:disabled)').click()");
                await Wait("appsConfirmDialog.open && appsConfirmDialog.getBoundingClientRect().bottom<=innerHeight", "Native reviewed uninstall dialog must fit");
                await View.CoreWebView2.ExecuteScriptAsync("document.getElementById('appsConfirmCancel').click();showAppPage('dashboardPage')");
                Console.WriteLine("PASS native App Manager real read-only inventory/categories/sizes, search-select-search hidden review, remove/cancel persistence and dialog fit; no real app removed");
                // Change only this disposable fixture's canonical frontend. The
                // running shell must see it through the ordinary backend revision.
                string assetPath=Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"public","app.js");
                byte[] originalAsset=File.ReadAllBytes(assetPath);
                try {
                    File.AppendAllText(assetPath,"\nwindow.__qaSharedFrontend='updated';\n");
                    await View.CoreWebView2.ExecuteScriptAsync("void checkDashboardUpdate()");
                    await Wait("window.__qaSharedFrontend==='updated' && !!window.monitoringLeaseId", "Native shared frontend update did not reload",45);
                    await Wait("eventSource?.readyState===1", "SSE did not recover after frontend update");
                } finally { File.WriteAllBytes(assetPath,originalAsset); }
                await Task.Delay(5100);
                await View.CoreWebView2.ExecuteScriptAsync("void checkDashboardUpdate()");
                await Wait("typeof window.__qaSharedFrontend==='undefined' && !!window.monitoringLeaseId", "Restored canonical frontend did not reload",45);
                await View.CoreWebView2.ExecuteScriptAsync("document.getElementById('openCpuDetailButton').click()");
                await Wait("cpuDetailDialog.open && cpuDetailProfileReady", "Native CPU detail did not activate");
                await View.CoreWebView2.ExecuteScriptAsync("document.getElementById('closeCpuDetailButton').click()");
                await Wait("!cpuDetailDialog.open", "Native CPU detail did not close");
                Check(form.Text=="Rovarin" && form.MinimumSize.Width>=760 && form.Width==900 && form.Height==680,"Window chrome/compact default size incorrect");
                Check(!View.CoreWebView2.Settings.AreDevToolsEnabled && !View.CoreWebView2.Settings.AreHostObjectsAllowed,"Unsafe native bridge/settings");
                await View.CoreWebView2.ExecuteScriptAsync("window.__qaApi=null;void Promise.all(['/api/metrics','/api/diagnostics','/api/maintenance/status','/api/maintenance/history'].map(p=>fetch(p,{headers:{'X-Monitor-Lease':window.monitoringLeaseId}}).then(r=>r.status))).then(x=>window.__qaApi=x.every(s=>s===200))");
                await Wait("window.__qaApi===true", "Existing API regression");
                await View.CoreWebView2.ExecuteScriptAsync("document.querySelector('[data-page=processesPage]').click()");
                await Wait("document.getElementById('processesPage')?.hidden===false", "Processes page navigation failed");
                await Wait("document.querySelector('.processes-killbar').getBoundingClientRect().bottom<=innerHeight && getComputedStyle(document.querySelector('.processes-table-wrap')).overflowY==='auto'", "Processes controls require outer-page scrolling");
                await Task.Delay(500);
                await View.CoreWebView2.ExecuteScriptAsync("window.__qaProcesses=null;void fetch('/api/processes',{headers:{'X-Monitor-Lease':window.monitoringLeaseId}}).then(r=>window.__qaProcesses=r.status)");
                await Wait("window.__qaProcesses===200", "Processes API unavailable");
                await Wait("!!document.querySelector('.process-technical-name')", "Real running-process friendly metadata must appear",45);
                await Wait("Array.from(document.querySelectorAll('#processesRows .process-name')).filter(x=>x.getAttribute('data-display-name')==='ChatGPT').length<2 || !!Array.from(document.querySelectorAll('.process-group .process-name')).find(x=>x.getAttribute('data-display-name')==='ChatGPT')", "Real ChatGPT instances, when present, should consolidate into a display group",45);
                await View.CoreWebView2.ExecuteScriptAsync("document.querySelector('#processesPage [data-sort=name]').click()");
                await Wait("(()=>{const c=new Intl.Collator(undefined,{sensitivity:'base',numeric:true}),n=Array.from(document.querySelectorAll('#processesRows .process-name')).map(x=>x.getAttribute('data-display-name'));return n.length>1&&n.every((x,i)=>!i||c.compare(n[i-1],x)<=0)})()", "Real process display names must sort A-Z");
                using(var image=File.Create(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"processes-polish.png"))) await View.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,image);
                await View.CoreWebView2.ExecuteScriptAsync("document.querySelector('#processesPage [data-sort=name]').click()");
                await Wait("(()=>{const c=new Intl.Collator(undefined,{sensitivity:'base',numeric:true}),n=Array.from(document.querySelectorAll('#processesRows .process-name')).map(x=>x.getAttribute('data-display-name'));return n.length>1&&n.every((x,i)=>!i||c.compare(n[i-1],x)>=0)})()", "Real process display names must sort Z-A");
                Console.WriteLine("PASS real process friendly/technical labels and alphabetical ascending/descending; identity unchanged");
                await View.CoreWebView2.ExecuteScriptAsync("document.querySelector('[data-page=dashboardPage]').click()");
                await View.CoreWebView2.ExecuteScriptAsync("scrollTo(0,0)");
                using(var image=File.Create(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"native-dashboard.png")))
                    await View.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,image);
                // Phone-sized presentation of the SAME document; no native bar.
                var desktopSize=form.Size; var desktopMinimum=form.MinimumSize; var desktopPadding=form.Padding; form.Padding=Padding.Empty;
                form.MinimumSize=new System.Drawing.Size(320,400); form.Size=new System.Drawing.Size(390,844);
                await View.CoreWebView2.ExecuteScriptAsync("document.documentElement.classList.remove('native-shell');syncPhoneSurface();document.body.style.setProperty('--app-safe-top','47px');scrollTo(0,0)");
                await Wait("innerWidth<=430 && document.documentElement.scrollWidth<=innerWidth && !document.body.classList.contains('sidebar-expanded') && getComputedStyle(document.querySelector('.app-sidebar')).visibility==='hidden'", "Shared mobile presentation overflow/closed drawer");
                await Wait("(()=>{const b=document.getElementById('sidebarToggle'),r=b.getBoundingClientRect();return r.width===48 && r.height===48 && getComputedStyle(b).borderRadius==='50%' && r.left>=18 && r.left<=22 && r.top>=47 && b.contains(document.elementFromPoint(r.left+24,r.top+24)) && getComputedStyle(document.querySelector('.native-app-identity')).display==='flex' && document.getElementById('appSectionTitle').textContent==='Dashboard' && document.querySelector('.sidebar-phone-brand').textContent.trim()==='Rovarin' && document.querySelector('.native-app-bar').getBoundingClientRect().height===60 && !document.querySelector('.dashboard-container').contains(b)})()", "Pinned phone header must retain circular menu, active section, drawer brand and safe-area placement");
                await View.CoreWebView2.ExecuteScriptAsync("document.getElementById('sidebarToggle').click()");
                await Wait("document.body.classList.contains('sidebar-expanded') && !document.getElementById('appSidebar').inert && document.querySelector('.phone-page-surface').getBoundingClientRect().left>=document.getElementById('appSidebar').getBoundingClientRect().width-1 && getComputedStyle(document.getElementById('sidebarBackdrop')).opacity==='1' && document.getElementById('dashboardPage').inert", "Menu must push page aside and expose accessible navigation");
                await Wait("(()=>{const n=document.getElementById('appSidebar');return !n.querySelector('[data-page=diagnosticsPage]') && !!document.getElementById('diagnosticsPage') && n.getBoundingClientRect().top===0 && ['Dashboard','Processes','Apps','Maintenance','Settings'].every(label=>Array.from(n.querySelectorAll('button')).some(b=>b.textContent.trim()===label && b.getBoundingClientRect().height>=44 && b.getBoundingClientRect().bottom<=innerHeight))})()", "Push drawer must expose every existing task and Settings");
                using(var image=File.Create(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"native-mobile-drawer.png")))
                    await View.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,image);
                await View.CoreWebView2.ExecuteScriptAsync("document.getElementById('sidebarBackdrop').click()");
                await Wait("!document.body.classList.contains('sidebar-expanded') && document.getElementById('appSidebar').inert && !document.getElementById('dashboardPage').inert && Math.abs(document.querySelector('.phone-page-surface').getBoundingClientRect().left)<1", "Dismiss must return the whole dashboard without disabling its actions");
                using(var image=File.Create(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"native-mobile.png")))
                    await View.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,image);
                foreach(var phoneSize in new System.Drawing.Size[]{new System.Drawing.Size(320,568),new System.Drawing.Size(375,812),new System.Drawing.Size(390,844),new System.Drawing.Size(430,932)}) {
                    int width=phoneSize.Width;
                    form.Size=phoneSize;
                    await Wait("innerWidth==="+width+" && document.documentElement.scrollWidth<=innerWidth", "Closed phone width/overflow at "+width);
                    await View.CoreWebView2.ExecuteScriptAsync("document.getElementById('sidebarToggle').click()");
                    await Wait("document.body.classList.contains('sidebar-expanded') && document.querySelector('.phone-page-surface').getBoundingClientRect().left>=document.getElementById('appSidebar').getBoundingClientRect().width-1", "Phone push animation at "+width);
                    await View.CoreWebView2.ExecuteScriptAsync("document.querySelector('[data-page=maintenancePage]').click()");
                    await Wait("!document.body.classList.contains('sidebar-expanded') && !document.getElementById('maintenancePage').hidden && !document.getElementById('maintenancePage').inert", "Phone maintenance navigation at "+width);
                    await Wait("document.documentElement.scrollWidth<=innerWidth && Array.from(document.querySelectorAll('.maint-action-card')).every(c=>c.getBoundingClientRect().left>=-1 && c.getBoundingClientRect().right<=innerWidth+1 && getComputedStyle(c).backdropFilter==='none')", "Phone maintenance card fit at "+width);
                    await View.CoreWebView2.ExecuteScriptAsync("document.getElementById('sidebarToggle').click()");
                    await Wait("(()=>{const b=document.getElementById('nativeSettingsButton'),r=b.getBoundingClientRect();return r.height>=44 && r.bottom<=innerHeight && b.contains(document.elementFromPoint(r.left+22,r.top+22))})()", "Phone Settings must remain reachable at "+width);
                    await View.CoreWebView2.ExecuteScriptAsync("document.getElementById('nativeSettingsButton').click()");
                    await Wait("!document.getElementById('diagnosticsPage').hidden && !document.body.classList.contains('sidebar-expanded') && !document.getElementById('diagnosticsPage').inert", "Phone Settings navigation at "+width);
                    foreach(var page in new string[]{"dashboardPage","processesPage","appsPage","diagnosticsPage"}) {
                        await View.CoreWebView2.ExecuteScriptAsync("showAppPage('"+page+"');document.querySelector('.dashboard-container').scrollTop=0");
                        await Wait("!document.getElementById('"+page+"').hidden && document.documentElement.scrollWidth<=innerWidth && document.querySelector('.native-app-bar').getBoundingClientRect().right<=innerWidth && getComputedStyle(document.querySelector('.metric-card')).backdropFilter==='none'", "Midnight phone page fit "+page+" at "+width+"x"+phoneSize.Height);
                    }
                    await View.CoreWebView2.ExecuteScriptAsync("showAppPage('dashboardPage');document.getElementById('openCpuDetailButton').click()");
                    await Wait("cpuDetailDialog.open && (()=>{const r=cpuDetailDialog.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight})()", "Phone detail dialog must fit at "+width);
                    await View.CoreWebView2.ExecuteScriptAsync("document.getElementById('closeCpuDetailButton').click()");
                    await View.CoreWebView2.ExecuteScriptAsync("document.querySelector('[data-page=dashboardPage]').click();scrollTo(0,200)");
                    await Wait("(window.scrollY===200 || document.documentElement.scrollTop===200) && document.querySelector('.native-app-bar').getBoundingClientRect().bottom<0 && document.documentElement.scrollWidth<=innerWidth", "In-page menu must scroll away without resizing the viewport at "+width);
                    await Task.Delay(350);
                    await Wait("(window.scrollY===200 || document.documentElement.scrollTop===200) && document.querySelector('.native-app-bar').getBoundingClientRect().bottom<0 && !document.body.classList.contains('sidebar-expanded')", "Stopped scrolling must not restore menu or bounce the page at "+width);
                    await View.CoreWebView2.ExecuteScriptAsync("scrollTo(0,0)");
                }
                await View.CoreWebView2.ExecuteScriptAsync("window.testPhoneSwipe=(target,x1,y1,x2,y2)=>{const fire=(type,x,y)=>{const t=new Touch({identifier:1,target,clientX:x,clientY:y});target.dispatchEvent(new TouchEvent(type,{bubbles:true,cancelable:true,touches:type==='touchend'?[]:[t],changedTouches:[t]}));};fire('touchstart',x1,y1);fire('touchmove',x2,y2);fire('touchend',x2,y2);}");
                await View.CoreWebView2.ExecuteScriptAsync("testPhoneSwipe(document.querySelector('.dashboard-container'),100,240,108,340)");
                await Wait("!document.body.classList.contains('sidebar-expanded')", "Vertical scrolling must not push the drawer open");
                await View.CoreWebView2.ExecuteScriptAsync("testPhoneSwipe(document.querySelector('canvas'),100,240,220,244)");
                await Wait("!document.body.classList.contains('sidebar-expanded')", "Graph gestures must not trigger the drawer");
                await View.CoreWebView2.ExecuteScriptAsync("testPhoneSwipe(document.querySelector('.dashboard-container'),100,240,240,244)");
                await Wait("document.body.classList.contains('sidebar-expanded') && document.querySelector('.phone-page-surface').getBoundingClientRect().left>=document.getElementById('appSidebar').getBoundingClientRect().width-1", "Anywhere right swipe must push the dashboard aside");
                await View.CoreWebView2.ExecuteScriptAsync("testPhoneSwipe(document.querySelector('#appSidebar [data-page=dashboardPage]'),200,240,60,244)");
                await Wait("!document.body.classList.contains('sidebar-expanded') && Math.abs(document.querySelector('.phone-page-surface').getBoundingClientRect().left)<1 && !document.getElementById('dashboardPage').inert", "Reverse swipe must smoothly return the page");
                await View.CoreWebView2.ExecuteScriptAsync("delete window.testPhoneSwipe;document.body.style.setProperty('--app-safe-top','0px')");
                await Wait("document.getElementById('sidebarToggle').getBoundingClientRect().top===14", "Zero safe inset must not clip circular menu");
                await View.CoreWebView2.ExecuteScriptAsync("document.body.style.setProperty('--app-safe-top','47px')");
                await Wait("document.getElementById('sidebarToggle').getBoundingClientRect().top===61", "Safe-area changes must reposition menu without doubled spacing");
                form.Size=new System.Drawing.Size(1440,900);
                await View.CoreWebView2.ExecuteScriptAsync("document.body.style.removeProperty('--app-safe-top')");
                await Wait("innerWidth===1440 && document.documentElement.scrollWidth<=innerWidth && getComputedStyle(document.body).backgroundAttachment.split(',').every(v=>v.trim()==='fixed') && getComputedStyle(document.querySelector('.metric-card')).backdropFilter==='none'", "Desktop canvas and solid data material changed unexpectedly");
                Console.WriteLine("PASS Midnight Glass phone 320x568/375x812/390x844/430x932: branded header, safe areas, stable scroll, push/reverse drawer, pages, settings, dialogs, touch targets and solid data surfaces (WebView2, not physical iOS)");
                form.Size=new System.Drawing.Size(390,844);
                await View.CoreWebView2.CallDevToolsProtocolMethodAsync("Emulation.setEmulatedMedia", "{\"features\":[{\"name\":\"prefers-reduced-motion\",\"value\":\"reduce\"},{\"name\":\"prefers-contrast\",\"value\":\"more\"}]}");
                await Wait("matchMedia('(prefers-reduced-motion: reduce)').matches && matchMedia('(prefers-contrast: more)').matches && getComputedStyle(document.querySelector('.phone-page-surface')).transitionDuration==='0s' && getComputedStyle(document.querySelector('.native-app-bar')).backdropFilter==='none' && getComputedStyle(document.documentElement).getPropertyValue('--text-secondary').trim()==='#c4d2e2'", "Accessible motion/contrast glass fallback missing");
                await View.CoreWebView2.CallDevToolsProtocolMethodAsync("Emulation.setEmulatedMedia", "{\"features\":[{\"name\":\"prefers-reduced-transparency\",\"value\":\"reduce\"}]}");
                if(await Condition("matchMedia('(prefers-reduced-transparency: reduce)').matches")) {
                    await Wait("getComputedStyle(document.querySelector('.native-app-bar')).backdropFilter==='none' && getComputedStyle(document.documentElement).getPropertyValue('--surface-glass').trim()==='#172232'", "Reduced-transparency material must be solid");
                    Console.WriteLine("PASS phone reduced-transparency solid material fallback");
                } else Console.WriteLine("NOTE runtime does not expose reduced-transparency media; solid default/contrast fallback checked");
                await View.CoreWebView2.CallDevToolsProtocolMethodAsync("Emulation.setEmulatedMedia", "{\"features\":[{\"name\":\"prefers-reduced-motion\",\"value\":\"no-preference\"},{\"name\":\"prefers-contrast\",\"value\":\"no-preference\"}]}");
                foreach(var scene in new string[]{"dashboardPage","processesPage","maintenancePage","diagnosticsPage"}) {
                    form.Size=new System.Drawing.Size(390,844);
                    await View.CoreWebView2.ExecuteScriptAsync("showAppPage('"+scene+"');document.querySelector('.dashboard-container').scrollTop=0");
                    if(scene=="processesPage") {
                        await Wait("document.querySelector('.processes-table tr.is-selectable')!==null", "Real process rows should load",20);
                        await View.CoreWebView2.ExecuteScriptAsync("document.querySelector('.processes-table tr.is-selectable').click();document.getElementById('processesFreezeButton').click()");
                        await Wait("document.getElementById('processesFreezeButton').getAttribute('aria-pressed')==='true' && !!document.querySelector('.processes-table tr.is-selected')", "Selected process and frozen state must remain visible");
                    }
                    await Task.Delay(600);
                    using(var image=File.Create(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"midnight-"+scene+".png"))) await View.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,image);
                    if(scene=="processesPage") {
                        await View.CoreWebView2.ExecuteScriptAsync("document.getElementById('processesFreezeButton').click()");
                        await Wait("document.getElementById('processesFreezeButton').getAttribute('aria-pressed')==='false'", "Resume live control must recover");
                    }
                }
                await View.CoreWebView2.ExecuteScriptAsync("showAppPage('processesPage')");
                await Wait("document.getElementById('processesFreezeButton').getAttribute('aria-pressed')==='false'", "Returning to Processes should remain live");
                await View.CoreWebView2.ExecuteScriptAsync("showAppPage('maintenancePage');document.getElementById('maint-btn-empty_recycle_bin').click()");
                await Wait("getComputedStyle(document.getElementById('maintModal')).display!=='none' && (()=>{const r=document.querySelector('.maint-modal').getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight})()", "Maintenance confirmation must fit without running an action");
                using(var image=File.Create(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"midnight-confirmation.png"))) await View.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,image);
                await View.CoreWebView2.ExecuteScriptAsync("document.getElementById('maintModalCancel').click();document.getElementById('nativeSettingsButton').click()");
                using(var image=File.Create(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"midnight-settings.png"))) await View.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,image);
                await View.CoreWebView2.ExecuteScriptAsync("document.documentElement.classList.add('native-shell');syncPhoneSurface()");
                foreach(var size in new System.Drawing.Size[]{new System.Drawing.Size(900,680),new System.Drawing.Size(980,740),new System.Drawing.Size(1440,900)}) {
                    form.Size=size;
                    foreach(var page in new string[]{"dashboardPage","processesPage","maintenancePage","diagnosticsPage"}) {
                        await View.CoreWebView2.ExecuteScriptAsync("showAppPage('"+page+"');document.querySelector('.dashboard-container').scrollTop=0");
                        await Wait("innerWidth==="+size.Width+" && document.documentElement.scrollWidth<=innerWidth && !document.getElementById('"+page+"').hidden && getComputedStyle(document.querySelector('.metric-card')).backdropFilter==='none' && getComputedStyle(document.querySelector('.native-app-bar')).backdropFilter==='none'", "Dense native desktop page fit "+page+" at "+size.Width+"x"+size.Height);
                    }
                }
                Console.WriteLine("PASS Midnight desktop 900x680/980x740/1440x900 all pages; reduced-motion/high-contrast no-blur fallback; confirmation cancel only");
                form.Padding=desktopPadding; form.MinimumSize=desktopMinimum; form.Size=desktopSize;
                await View.CoreWebView2.ExecuteScriptAsync("document.body.style.removeProperty('--app-safe-top');document.documentElement.classList.add('native-shell');syncPhoneSurface()");
                // The same SC_CLOSE path used by Alt+F4 hides to tray, preserving Node.
                SendMessage(form.Handle,0x112,new IntPtr(0xF060),IntPtr.Zero);
                await Task.Delay(100);
                Check(!form.Visible,"System close did not hide to tray");
                View.CoreWebView2.Resume();
                await Wait("!dashboardClientVisible()", "Hidden desktop did not hide client");
                await WaitLeases(false);
                Invoke("OpenWindow");
                await Wait("dashboardClientVisible()", "Tray reopen did not show client");
                await WaitLeases(true);
                var minimizeButton=(Button)window.GetField("desktopMinimize",flags).GetValue(form);
                Check(minimizeButton.Visible && minimizeButton.AccessibleName=="Minimize Rovarin","Native minimize control missing");
                minimizeButton.PerformClick();
                Check(form.WindowState==FormWindowState.Minimized,"Minimize button did not minimize");
                View.CoreWebView2.Resume();
                await Wait("!dashboardClientVisible()", "Minimized desktop did not hide client");
                await WaitLeases(false);
                Invoke("OpenWindow"); await WaitLeases(true);
                // Embedded remote/file navigation is rejected without changing origin.
                View.CoreWebView2.Navigate("file:///C:/Windows/win.ini"); await Task.Delay(300);
                Check(View.CoreWebView2.Source.StartsWith(origin),"Untrusted navigation accepted");
                await View.CoreWebView2.ExecuteScriptAsync("window.__qaLogout=null;void fetch('/api/logout',{method:'POST'}).then(r=>window.__qaLogout=r.status)");
                await Wait("window.__qaLogout===200", "Logout failed");
                await View.CoreWebView2.ExecuteScriptAsync("window.__qaRevoked=null;void fetch('/api/metrics').then(r=>window.__qaRevoked=r.status)");
                await Wait("window.__qaRevoked===401", "Revoked native cookie accepted");
                await View.CoreWebView2.ExecuteScriptAsync("window.__qaLogin=null;void fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin:"+json.Serialize(pin)+"})}).then(r=>window.__qaLogin=r.status)");
                await Wait("window.__qaLogin===200", "Session persistence setup failed");
                for(int cycle=0;cycle<2;cycle++) {
                    var expectedBounds=form.Bounds;
                    if(cycle==1) form.WindowState=FormWindowState.Maximized;
                    await View.CoreWebView2.ExecuteScriptAsync("document.getElementById('logoutButton').click()");
                    await Wait("!!document.getElementById('pinInput') && document.readyState==='complete'", "Relock did not navigate to login");
                    await Task.Delay(200);
                    Check(((bool)window.GetField("lockUsesDwmCorners",flags).GetValue(form) || form.Region!=null) && form.Width==360 && form.Height<480 && form.WindowState==FormWindowState.Normal,"Repeated relock presentation failed");
                    await Wait("getComputedStyle(document.querySelector('.login-container')).overflowY==='hidden' && !document.querySelector('.native-app-bar')", "Relock did not restore login scroll lock");
                    await View.CoreWebView2.ExecuteScriptAsync("document.getElementById('pinInput').value="+json.Serialize(pin)+";document.getElementById('pinInput').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
                    await Wait("!!window.monitoringLeaseId && !!document.getElementById('dashboardPage')", "Enter unlock did not restore dashboard",30);
                    await Task.Delay(200);
                    Check(form.Region==null && form.WindowState==(cycle==1?FormWindowState.Maximized:FormWindowState.Normal),"Unlock did not restore normal native state");
                    if(cycle==0) Check(form.Bounds==expectedBounds,"Unlock changed normal window position/size");
                    Invoke("SaveBounds");
                    var persisted=json.Deserialize<System.Collections.Generic.Dictionary<string,int>>(File.ReadAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"..","data","desktop-window.json")));
                    Check(persisted["width"]==expectedBounds.Width && persisted["height"]==expectedBounds.Height && persisted["maximized"]==(cycle==1?1:0),"Login dimensions/state contaminated saved normal bounds");
                    if(cycle==1) form.WindowState=FormWindowState.Normal;
                    await WaitLeases(true);
                }
                Console.WriteLine("PASS rounded native lock-only window, repeated lock/Enter-unlock, exact normal/maximized restoration and saved bounds isolation");
                var exitButton=(Button)window.GetField("desktopExit",flags).GetValue(form);
                Check(exitButton.Visible && exitButton.AccessibleName=="Exit desktop app","Native top-right X missing");
                Console.WriteLine("PASS native borderless edges, draggable shared top bar, existing Settings, hidden scrollbars with scrolling, system-close/tray reopen, PIN auth/revocation, APIs, CPU detail, SSE, processes navigation, lease release, restricted navigation");
                await View.CoreWebView2.ExecuteScriptAsync("document.getElementById('logoutButton').click()");
                await Wait("!!document.getElementById('lock-window-exit') && document.readyState==='complete'", "Locked exit control missing after relock");
                // Preserve the existing subsequent real-EXE saved-session test:
                // authenticate this disposable cookie jar without navigating away
                // from the locked document whose integrated X we are exercising.
                await View.CoreWebView2.ExecuteScriptAsync("window.__qaLogin=null;void fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin:"+json.Serialize(pin)+"})}).then(r=>window.__qaLogin=r.status)");
                await Wait("window.__qaLogin===200", "Saved-session fixture authentication failed");
                await View.CoreWebView2.ExecuteScriptAsync("window.addEventListener('pc-monitor-desktop-visibility',()=>{const until=Date.now()+3500;while(Date.now()<until){}})");
                var closed=new TaskCompletionSource<bool>();form.FormClosed+=delegate{closed.TrySetResult(true);};
                await View.CoreWebView2.ExecuteScriptAsync("document.getElementById('lock-window-exit').click()");
                await Task.Delay(100);
                Check((bool)window.GetField("exiting",flags).GetValue(form),"Integrated locked X did not request shell-only exit");
                Check(await Task.WhenAny(closed.Task,Task.Delay(2000))==closed.Task,"Native X waited indefinitely for a stalled view");
                Console.WriteLine("PASS integrated locked X uses existing bounded shell-only Exit semantics (stalled visibility handler)");
                result=0;
            } catch(Exception error) { result=1; Console.Error.WriteLine(error.Message); }
            finally { Invoke("ExitShell"); }
        };
        Application.Run(form); form.Dispose(); return result;
    }
}

