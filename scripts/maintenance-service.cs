// Production administrator maintenance service: enrollment, status, revocation, and allowlisted execution.
using System;
using System.IO;
using System.IO.Pipes;
using System.Diagnostics;
using System.ServiceProcess;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

internal sealed partial class MaintenanceFoundation : ServiceBase {
    internal const string PipeName = "RovarinMaintenanceFoundation-v1";
    internal static readonly string Root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "RovarinMaintenance");
    static readonly string Image = Path.Combine(Root, "RovarinMaintenanceService.exe");
    internal static readonly string PolicyPath = Path.Combine(Root, "owner.policy");
    static readonly string SystemSid = "S-1-5-18", AdminSid = "S-1-5-32-544";
    static readonly string TrustedInstallerSid = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
    internal static readonly string[] Allowed = { "windows_repair", "sfc_scan", "dism_check", "reset_network", "clear_dns" };
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 8192 };
    static readonly object OutputLock = new object();
    volatile bool stopped;
    NamedPipeServerStream active;
    Thread thread;
    internal sealed class Policy {
        internal string Owner = "";
        internal bool Enabled;
        internal long Generation;
    }
    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int Length; public IntPtr Descriptor; public int Inherit; }
    [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string sddl, uint revision, out IntPtr descriptor, out uint length);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern SafePipeHandle CreateNamedPipe(string name, uint openMode, uint pipeMode, uint instances, uint output, uint input, uint timeout, ref SecurityAttributes attributes);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint pid);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr value);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr handle,int type,ref JobLimits limits,int length);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr handle,IntPtr process);
    [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr handle,uint code);
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits { public long ProcessTime,JobTime; public uint Flags; public UIntPtr MinWorking,MaxWorking; public uint Active; public UIntPtr Affinity; public uint Priority,Scheduling; }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOperations,WriteOperations,OtherOperations,ReadBytes,WriteBytes,OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct JobLimits { public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory,JobMemory,PeakProcess,PeakJob; }
    [StructLayout(LayoutKind.Sequential)] struct FileInfo { public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Created,Accessed,Written; public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow; }
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle file,out FileInfo info);

    [DllImport("advapi32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr OpenSCManager(string machine,string database,uint access);
    [DllImport("advapi32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr OpenService(IntPtr manager,string name,uint access);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool CloseServiceHandle(IntPtr handle);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool QueryServiceObjectSecurity(IntPtr service,uint information,byte[] descriptor,uint length,out uint needed);
    [DllImport("advapi32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool QueryServiceConfig(IntPtr service,IntPtr config,uint length,out uint needed);
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct ServiceConfig {
        public uint Type,Start,Error;
        public IntPtr Binary,Group;public uint Tag;public IntPtr Dependencies,Account,Display;
    }
    internal static void ValidateServiceAcl(RawSecurityDescriptor acl) {
        if(acl.Owner==null || !PrivilegedSid(acl.Owner.Value) || acl.DiscretionaryAcl==null) throw new InvalidDataException("unsafe-service-acl");
        foreach(GenericAce entry in acl.DiscretionaryAcl) {
            var ace=entry as QualifiedAce;
            // Configuration change, start/stop, delete, write-DACL/owner, generic write/all.
            if(ace==null || (ace.AceQualifier==AceQualifier.AccessAllowed && !PrivilegedSid(ace.SecurityIdentifier.Value) && (ace.AccessMask & unchecked((int)0x700D0032))!=0)) throw new InvalidDataException("unsafe-service-acl");
        }
    }
    static void ValidateServiceRegistration() {
        IntPtr manager=OpenSCManager(null,null,1);if(manager==IntPtr.Zero)throw new InvalidDataException("service-unavailable");
        try {
            IntPtr service=OpenService(manager,"RovarinMaintenanceFoundation",0x00020005);
            if(service==IntPtr.Zero)throw new InvalidDataException("service-unavailable");
            try {
                uint needed;QueryServiceObjectSecurity(service,5,null,0,out needed);
                if(needed==0 || needed>65536)throw new InvalidDataException("unsafe-service-acl");
                var bytes=new byte[needed];if(!QueryServiceObjectSecurity(service,5,bytes,needed,out needed))throw new InvalidDataException("unsafe-service-acl");
                ValidateServiceAcl(new RawSecurityDescriptor(bytes,0));
                QueryServiceConfig(service,IntPtr.Zero,0,out needed);if(needed==0 || needed>65536)throw new InvalidDataException("unsafe-service-config");
                IntPtr buffer=Marshal.AllocHGlobal((int)needed);
                try {
                    if(!QueryServiceConfig(service,buffer,needed,out needed))throw new InvalidDataException("unsafe-service-config");
                    var config=(ServiceConfig)Marshal.PtrToStructure(buffer,typeof(ServiceConfig));
                    if(config.Type!=0x10 || config.Start!=2 || Marshal.PtrToStringUni(config.Binary)!="\""+Image+"\"" || Marshal.PtrToStringUni(config.Account)!="LocalSystem")throw new InvalidDataException("unsafe-service-config");
                }finally{Marshal.FreeHGlobal(buffer);}
            }finally{CloseServiceHandle(service);}
        }finally{CloseServiceHandle(manager);}
    }
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool SetKernelObjectSecurity(IntPtr handle,uint information,IntPtr descriptor);
    internal static string ProcessQuerySddl(string owner) {
        if(owner!="" && !ValidOwner(owner))throw new InvalidDataException("invalid-owner");
        // Owner may verify the SYSTEM service image through a held query-only handle.
        // No terminate, VM-write, duplicate-handle, token or service-control rights.
        return "O:SYG:SYD:P(A;;GA;;;SY)(A;;GA;;;BA)" +
            (owner=="" ? "" : "(A;;0x1000;;;"+owner+")");
    }
    static void AllowOwnerProcessQuery(string owner) {
        IntPtr descriptor;uint length;
        if(!ConvertStringSecurityDescriptorToSecurityDescriptor(ProcessQuerySddl(owner),1,out descriptor,out length))throw new InvalidDataException("process-query-acl");
        try {if(!SetKernelObjectSecurity(GetCurrentProcess(),0x80000004,descriptor))throw new InvalidDataException("process-query-acl");}
        finally{LocalFree(descriptor);}
    }
    internal static bool PrivilegedSid(string sid) { return sid==SystemSid || sid==AdminSid || sid==TrustedInstallerSid; }
    internal static void ProtectedPath(string path, bool directory, bool ancestor = false) {
        FileSystemInfo entry = directory ? (FileSystemInfo)new DirectoryInfo(path) : new System.IO.FileInfo(path);
        if(!entry.Exists || (entry.Attributes & FileAttributes.ReparsePoint)!=0) throw new InvalidDataException("unsafe-path");
        FileSystemSecurity acl = directory ? (FileSystemSecurity)Directory.GetAccessControl(path) : File.GetAccessControl(path);
        if(!PrivilegedSid(((SecurityIdentifier)acl.GetOwner(typeof(SecurityIdentifier))).Value)) throw new InvalidDataException("unsafe-owner");
        var write = FileSystemRights.WriteData | FileSystemRights.AppendData | FileSystemRights.WriteAttributes | FileSystemRights.WriteExtendedAttributes | FileSystemRights.Delete | FileSystemRights.DeleteSubdirectoriesAndFiles | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership;
        if(ancestor) write = FileSystemRights.Delete | FileSystemRights.DeleteSubdirectoriesAndFiles | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership;
        foreach(FileSystemAccessRule rule in acl.GetAccessRules(true,true,typeof(SecurityIdentifier))) {
            if(rule.AccessControlType==AccessControlType.Allow && (rule.PropagationFlags & PropagationFlags.InheritOnly)==0 && (rule.FileSystemRights & write)!=0 && !PrivilegedSid(((SecurityIdentifier)rule.IdentityReference).Value)) throw new InvalidDataException("unsafe-acl");
        }
        if(!directory) using(var file=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read)) {
            FileInfo info; if(!GetFileInformationByHandle(file.SafeFileHandle,out info) || info.Links!=1) throw new InvalidDataException("unsafe-links");
        }
    }
    // Avoid collision with the native file-information structure name.

    internal static void ValidateDeployment() {
        string current=System.Reflection.Assembly.GetExecutingAssembly().Location;
        if(!String.Equals(Path.GetFullPath(current),Image,StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("unprotected-deployment");
        for(var directory=new DirectoryInfo(Root); directory!=null; directory=directory.Parent) ProtectedPath(directory.FullName,true,!String.Equals(directory.FullName,Root,StringComparison.OrdinalIgnoreCase));
        ProtectedPath(Image,false);
        ValidateImageDigest();
    }
    internal static Policy Load() {
        if(!File.Exists(PolicyPath)) return new Policy();
        ProtectedPath(PolicyPath,false);
        return ParsePolicy(File.ReadAllText(PolicyPath,Encoding.UTF8));
    }
    internal static Policy ParsePolicy(string text) {
        var parts=text.Split('|');
        long generation;
        if(parts.Length!=3 || !ValidOwner(parts[0]) || (parts[1]!="0" && parts[1]!="1") || !Int64.TryParse(parts[2],out generation) || generation<1) throw new InvalidDataException("invalid-policy");
        return new Policy {Owner=parts[0],Enabled=parts[1]=="1",Generation=generation};
    }
    internal static void Save(Policy policy) {
        string temporary=Path.Combine(Root,"owner-"+Guid.NewGuid().ToString("N")+".tmp");
        try {
            using(var file=new FileStream(temporary,FileMode.CreateNew,FileAccess.Write,FileShare.None)) {
                var bytes=Encoding.UTF8.GetBytes(policy.Owner+"|"+(policy.Enabled?"1":"0")+"|"+policy.Generation);
                file.Write(bytes,0,bytes.Length);file.Flush(true);
            }
            var acl=new FileSecurity();acl.SetAccessRuleProtection(true,false);acl.SetOwner(new SecurityIdentifier(WindowsIdentity.GetCurrent().User.Value==SystemSid?SystemSid:AdminSid));
            foreach(string sid in new[]{SystemSid,AdminSid}) acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),FileSystemRights.FullControl,AccessControlType.Allow));
            File.SetAccessControl(temporary,acl);ProtectedPath(temporary,false);
            if(File.Exists(PolicyPath)) {ProtectedPath(PolicyPath,false);File.Replace(temporary,PolicyPath,null);} else File.Move(temporary,PolicyPath);
        } finally {if(File.Exists(temporary)) File.Delete(temporary);}
    }
    internal static bool ValidOwner(string sid) { return sid!=null && System.Text.RegularExpressions.Regex.IsMatch(sid,@"\AS-1-5-21-\d{1,10}-\d{1,10}-\d{1,10}-\d{1,10}\z"); }
    internal static bool ValidAction(string action) { return Array.IndexOf(Allowed,action)>=0; }
    static object ResultMessage(string action,bool success,string code,string summary,int? exitCode=null) {
        return new { type="result",action=action,success=success,code=code,summary=summary,exitCode=exitCode };
    }
    internal static string Dispatch(Policy policy, string sid, bool admin, string challenge, string request, Action<Policy> save) {
        if(request==null || request.Length>256) return "invalid-request";
        var parts=request.Split('|');
        if(parts.Length<3 || parts[0]!="1" || parts[1]!=challenge) return "invalid-request";
        if(!admin && (policy.Owner=="" || sid!=policy.Owner)) return "unauthorized";
        if(parts[2]=="status" && parts.Length==3) return policy.Enabled?"enabled":"disabled";
        if(parts[2]=="enroll" && parts.Length==4) {
            if(!admin || !ValidOwner(parts[3])) return "unauthorized";
            if(policy.Owner!="" && policy.Owner!=parts[3]) return "owner-conflict";
            var next=new Policy {Owner=parts[3],Enabled=true,Generation=checked(policy.Generation+1)};
            save(next);policy.Owner=next.Owner;policy.Enabled=true;policy.Generation=next.Generation;return "enabled";
        }
        if(parts[2]=="revoke" && parts.Length==3 && policy.Owner!="") {
            var next=new Policy {Owner=policy.Owner,Enabled=false,Generation=checked(policy.Generation+1)};
            save(next);policy.Enabled=false;policy.Generation=next.Generation;return "disabled";
        }
        if(parts[2]=="execute" && parts.Length==4) {
            if(!policy.Enabled) return "disabled";
            if(policy.Owner=="" || sid!=policy.Owner) return "unauthorized";
            if(!ValidAction(parts[3])) return "invalid-request";
            return "authorized";
        }
        return "invalid-request";
    }
    internal static string PipeSddl(Policy policy) {
        return "O:SYG:SYD:P(D;;GA;;;NU)(A;;GA;;;SY)(A;;GA;;;BA)"+(policy.Owner==""?"":"(A;;GRGW;;;"+policy.Owner+")");
    }
    static NamedPipeServerStream MakePipe(Policy policy) {
        IntPtr descriptor;uint size;
        if(!ConvertStringSecurityDescriptorToSecurityDescriptor(PipeSddl(policy),1,out descriptor,out size)) throw new InvalidDataException("pipe-acl");
        try {
            var attributes=new SecurityAttributes {Length=Marshal.SizeOf(typeof(SecurityAttributes)),Descriptor=descriptor};
            // FIRST_PIPE_INSTANCE prevents joining a squatted pipe; REJECT_REMOTE_CLIENTS rejects SMB clients.
            var handle=CreateNamedPipe(@"\\.\pipe\"+PipeName,0x00000003|0x40000000|0x00080000,0x00000008,1,512,512,0,ref attributes);
            if(handle.IsInvalid) {handle.Dispose();throw new InvalidDataException("pipe-unavailable");}
            return new NamedPipeServerStream(PipeDirection.InOut,true,false,handle);
        } finally {LocalFree(descriptor);}
    }
    static string ReadBounded(Stream stream) {
        var bytes=new byte[257];int count=0,next;
        while(count<bytes.Length && (next=stream.ReadByte())>=0) {if(next==10)return Encoding.ASCII.GetString(bytes,0,count);if(next<32 || next>126)throw new InvalidDataException();bytes[count++]=(byte)next;}
        throw new InvalidDataException("invalid-request");
    }
    static void Send(Stream stream,string value) {var bytes=Encoding.ASCII.GetBytes(value+"\n");lock(stream){stream.Write(bytes,0,bytes.Length);stream.Flush();}}
    static string ProcessSid(Process process) {
        IntPtr token;if(!OpenProcessToken(process.Handle,8,out token))throw new InvalidDataException("identity-unavailable");
        try {using(var identity=new WindowsIdentity(token))return identity.User.Value;}finally{CloseHandle(token);}
    }
    static void ExecuteAction(NamedPipeServerStream pipe, string action, Process peer) {
        IntPtr job=CreateJobObject(IntPtr.Zero,null);
        var limits=new JobLimits();limits.Basic.Flags=0x2000;
        if(job!=IntPtr.Zero) SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(limits));
        int finished=0, timedOut=0;
        var disconnectWatcher=new Thread(delegate() {
            try {
                while(Interlocked.CompareExchange(ref finished,0,0)==0) {
                    if(peer.HasExited) {if(job!=IntPtr.Zero) TerminateJobObject(job,3); break;}
                    Thread.Sleep(200);
                }
            } catch {}
        });
        disconnectWatcher.IsBackground=true;disconnectWatcher.Start();
        Action<object> sendJson=delegate(object msg) {
            try {Send(pipe,Json.Serialize(msg));}
            catch {if(Interlocked.CompareExchange(ref finished,0,0)==0 && job!=IntPtr.Zero) TerminateJobObject(job,3);}
        };
        string[][] commands;
        switch(action) {
            case "windows_repair":
                commands=new[]{
                    new[]{"dism.exe","/online /cleanup-image /checkhealth"},
                    new[]{"dism.exe","/online /cleanup-image /scanhealth"},
                    new[]{"dism.exe","/online /cleanup-image /restorehealth"},
                    new[]{"sfc.exe","/scannow"}
                };break;
            case "sfc_scan":commands=new[]{new[]{"sfc.exe","/scannow"}};break;
            case "dism_check":
                commands=new[]{
                    new[]{"dism.exe","/online /cleanup-image /checkhealth"},
                    new[]{"dism.exe","/online /cleanup-image /scanhealth"}
                };break;
            case "clear_dns":commands=new[]{new[]{"ipconfig.exe","/flushdns"}};break;
            case "reset_network":
                commands=new[]{
                    new[]{"netsh.exe","winsock reset"},
                    new[]{"netsh.exe","int ip reset"}
                };break;
            default:sendJson(ResultMessage(action,false,"invalid-action","Unsupported maintenance action."));return;
        }
        // Bound the operation without discarding its final result.
        using(var operationTimeout=new Timer(delegate {if(Interlocked.CompareExchange(ref finished,0,0)!=0)return;Interlocked.Exchange(ref timedOut,1);if(job!=IntPtr.Zero)TerminateJobObject(job,258);},null,35*60*1000,Timeout.Infinite))
        try {
            int lines=0;var sfcText=new StringBuilder();
            int netshOk=0,netshFail=0;bool netshReboot=false;
            for(int i=0;i<commands.Length;i++) {
                if(peer.HasExited) {if(job!=IntPtr.Zero) TerminateJobObject(job,3); return;}
                string tool=Path.Combine(Environment.SystemDirectory,commands[i][0]);
                if(!File.Exists(tool)) {sendJson(ResultMessage(action,false,"tool-unavailable","The required Windows maintenance tool is unavailable."));return;}
                sendJson(new {type="progress",action=action,step=i+1,total=commands.Length,message="Running "+commands[i][0]+" (step "+(i+1)+" of "+commands.Length+")"});
                using(var child=new Process()) {
                    child.StartInfo=new ProcessStartInfo(tool,commands[i][1]) {
                        UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true,WorkingDirectory=Environment.SystemDirectory
                    };
                    child.StartInfo.EnvironmentVariables.Remove("__COMPAT_LAYER");
                    if(commands[i][0]=="sfc.exe") child.StartInfo.StandardOutputEncoding=Encoding.Unicode;
                    DataReceivedEventHandler output=delegate(object sender,DataReceivedEventArgs e) {
                        if(!String.IsNullOrWhiteSpace(e.Data)) {
                            string text=e.Data.Replace("\0","");
                            if(commands[i][0]=="sfc.exe") lock(OutputLock) {if(sfcText.Length<16000) sfcText.Append(text).Append(" ");}
                            if(action=="reset_network") {
                                if(text.Contains(", OK!") || text.IndexOf("Successfully reset",StringComparison.OrdinalIgnoreCase)>=0 || text.IndexOf("Sucessfully reset",StringComparison.OrdinalIgnoreCase)>=0) Interlocked.Increment(ref netshOk);
                                if(text.Contains(", failed.") || text.IndexOf("Access is denied",StringComparison.OrdinalIgnoreCase)>=0) Interlocked.Increment(ref netshFail);
                                if(text.IndexOf("restart the computer",StringComparison.OrdinalIgnoreCase)>=0) netshReboot=true;
                            }
                            if(Interlocked.Increment(ref lines)<=500) sendJson(new {type="log",action=action,message=text.Length>2000?text.Substring(0,2000):text});
                        }
                    };
                    child.OutputDataReceived+=output;child.ErrorDataReceived+=output;
                    try {
                        child.Start();
                        if(job!=IntPtr.Zero) AssignProcessToJobObject(job,child.Handle);
                        child.BeginOutputReadLine();child.BeginErrorReadLine();child.WaitForExit();
                    } catch {sendJson(ResultMessage(action,false,"tool-failed","A Windows maintenance tool could not run."));return;}
                    if(Interlocked.CompareExchange(ref timedOut,0,0)!=0) {
                        sendJson(ResultMessage(action,false,"timeout","Windows maintenance exceeded its time limit. Its owned tools were stopped; Windows servicing logs were preserved.",258));return;
                    }
                    if(child.ExitCode!=0) {
                        if(action=="reset_network" && commands[i][0]=="netsh.exe" && commands[i][1]=="int ip reset" && netshOk>0 && netshReboot) {
                            // Partial completion allowed only when Winsock + compartments succeeded and reboot was requested.
                        } else {
                            sendJson(ResultMessage(action,false,"operation-failed","Windows maintenance failed at step "+(i+1)+" (exit "+child.ExitCode+").",child.ExitCode));return;
                        }
                    }
                }
            }
            string sfc=sfcText.ToString().ToLowerInvariant();
            if(sfc.Contains("unable to fix some of them") || sfc.Contains("found corrupt files but was unable to fix")) {
                sendJson(ResultMessage(action,false,"operation-failed","SFC found corruption it could not repair. Review CBS.log.",0));return;
            }
            if(action=="reset_network") {
                if(netshFail>0 && netshOk>0 && netshReboot) {
                    sendJson(ResultMessage(action,false,"partially-completed","Network reset partially completed (some protected system settings require restart). Restart your PC to finish applying it.",0));
                    return;
                }
                if(netshFail>0 || !netshReboot || netshOk==0) {
                    sendJson(ResultMessage(action,false,"operation-failed","Network reset could not complete successfully.",1));
                    return;
                }
                sendJson(ResultMessage(action,true,"completed","Network reset completed. Restart your PC to finish applying it.",0));
                return;
            }
            sendJson(ResultMessage(action,true,"completed","Windows maintenance completed successfully.",0));
        } finally {
            Interlocked.Exchange(ref finished,1);
            using(var drained=new ManualResetEvent(false)){if(operationTimeout.Dispose(drained))drained.WaitOne();}
            if(job!=IntPtr.Zero) CloseHandle(job);
        }
    }
    void Serve() {
        try {
            while(!stopped) {
                var policy=Load();
                using(var pipe=MakePipe(policy)) {
                    active=pipe;pipe.WaitForConnection();
                    try {
                    using(var timeout=new Timer(delegate {try{pipe.Dispose();}catch{}},null,3000,Timeout.Infinite)) {
                        if(ReadBounded(pipe)!="1|hello")throw new InvalidDataException("invalid-handshake");
                        uint pid;if(!GetNamedPipeClientProcessId(pipe.SafePipeHandle,out pid))throw new InvalidDataException("identity-unavailable");
                        using(var peer=Process.GetProcessById((int)pid)) {
                            string sid=null;bool admin=false;
                            pipe.RunAsClient(delegate {using(var identity=WindowsIdentity.GetCurrent(true)) {sid=identity.User.Value;admin=new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);}});
                            if(peer.HasExited || ProcessSid(peer)!=sid) throw new InvalidDataException("identity-mismatch");
                            string challenge=Guid.NewGuid().ToString("N");Send(pipe,challenge);
                            string request=ReadBounded(pipe);
                            if(peer.HasExited) throw new InvalidDataException("peer-exited");
                            string response=Dispatch(policy,sid,admin,challenge,request,Save);
                            if(response=="authorized") {
                                timeout.Change(Timeout.Infinite,Timeout.Infinite);
                                string action=request.Split('|')[3];
                                ExecuteAction(pipe,action,peer);
                            } else {
                                Send(pipe,response);
                            }
                        }
                    }
                    } catch(InvalidDataException) { } catch(ObjectDisposedException) { }
                    active=null;
                }
            }
        } catch { // Fail closed: SCM sees a stopped service; no authorized operation is available.
            if(!stopped) ExitCode=1;
            Stop();
        }
    }
    protected override void OnStart(string[] args) {
        ValidateDeployment();ValidateServiceRegistration();if(WindowsIdentity.GetCurrent().User.Value!=SystemSid)throw new InvalidDataException("wrong-service-account");
        var policy=Load();AllowOwnerProcessQuery(policy.Owner);stopped=false;thread=new Thread(Serve){IsBackground=true};thread.Start();
    }
    protected override void OnStop() {stopped=true;try{if(active!=null)active.Dispose();}catch{}if(thread!=null && Thread.CurrentThread!=thread)thread.Join(4000);}
    MaintenanceFoundation() {ServiceName="RovarinMaintenanceFoundation";CanStop=true;AutoLog=false;}
    static int Client(string action,string owner) {
        ValidateServiceRegistration();
        using(var pipe=new NamedPipeClientStream(".",PipeName,PipeDirection.InOut,PipeOptions.Asynchronous,TokenImpersonationLevel.Impersonation)) {
            pipe.Connect(5000);
            uint pid;if(!GetNamedPipeServerProcessId(pipe.SafePipeHandle,out pid))return 1;
            using(var peer=Process.GetProcessById((int)pid)) {
                if(!VerifiedServicePeer(pid))return 1;
                if(action=="status" || action=="revoke" || action=="enroll") {
                    using(var timeout=new Timer(delegate {try{pipe.Dispose();}catch{}},null,3000,Timeout.Infinite)) {
                        Send(pipe,"1|hello");
                        string challenge=ReadBounded(pipe);if(!System.Text.RegularExpressions.Regex.IsMatch(challenge,@"\A[0-9a-f]{32}\z"))return 1;
                        Send(pipe,"1|"+challenge+"|"+action+(owner==null?"":"|"+owner));
                        string result=ReadBounded(pipe);Console.WriteLine(result);return result=="enabled" || result=="disabled"?0:1;
                    }
                }
                if(ValidAction(action)) {
                    Send(pipe,"1|hello");
                    string challenge=ReadBounded(pipe);if(!System.Text.RegularExpressions.Regex.IsMatch(challenge,@"\A[0-9a-f]{32}\z"))return 1;
                    Send(pipe,"1|"+challenge+"|execute|"+action);
                    using(var timeout=new Timer(delegate {try{pipe.Dispose();}catch{}},null,36*60*1000,Timeout.Infinite)) {
                        using(var reader=new StreamReader(pipe,Encoding.ASCII)) {
                            string line;
                            while((line=reader.ReadLine())!=null) {
                                Console.WriteLine(line);
                                if(line.StartsWith("{\"type\":\"result\",")) {
                                    return line.Contains("\"success\":true")?0:1;
                                }
                            }
                        }
                    }
                    return 1;
                }
                return 2;
            }
        }
    }
    static int SelfTest() {
        var p=new Policy();string sid="S-1-5-21-1-2-3-1001",other="S-1-5-21-1-2-3-1002",nonce=Guid.NewGuid().ToString("N");int saves=0;
        Action<bool> assert=delegate(bool value){if(!value)throw new Exception("self-test failed");};
        Action<Policy> save=delegate(Policy ignored){saves++;};
        assert(ValidAction("windows_repair") && ValidAction("sfc_scan") && ValidAction("dism_check") && ValidAction("reset_network") && ValidAction("clear_dns"));
        assert(!ValidAction("cmd.exe") && !ValidAction("powershell.exe") && !ValidAction(""));
        assert(Dispatch(p,sid,false,nonce,"1|"+nonce+"|status",save)=="unauthorized");
        assert(Dispatch(p,sid,false,nonce,"1|"+nonce+"|enroll|"+sid,save)=="unauthorized");
        assert(Dispatch(p,sid,true,nonce,"1|"+nonce+"|enroll|"+sid,save)=="enabled");
        assert(Dispatch(p,other,false,nonce,"1|"+nonce+"|revoke",save)=="unauthorized");
        assert(Dispatch(p,sid,false,nonce,"1|stale|revoke",save)=="invalid-request");
        assert(Dispatch(p,sid,false,nonce,"1|"+nonce+"|execute|cmd.exe",save)=="invalid-request");
        assert(Dispatch(p,sid,false,nonce,"1|"+nonce+"|execute|clear_dns",save)=="authorized");
        assert(Dispatch(p,other,false,nonce,"1|"+nonce+"|execute|clear_dns",save)=="unauthorized");
        assert(Dispatch(p,sid,true,nonce,"1|"+nonce+"|enroll|"+other,save)=="owner-conflict");
        assert(Dispatch(p,sid,false,nonce,"1|"+nonce+"|revoke",save)=="disabled" && saves==2 && p.Generation==2);
        assert(Dispatch(p,sid,false,nonce,"1|"+nonce+"|execute|clear_dns",save)=="disabled");
        assert(Dispatch(p,sid,false,nonce,"1|"+nonce+"|enroll|"+sid,save)=="unauthorized");
        try{Dispatch(p,sid,true,nonce,"1|"+nonce+"|enroll|"+sid,delegate(Policy ignored){throw new IOException();});assert(false);}catch(IOException){}
        assert(!p.Enabled && p.Generation==2);
        assert(PipeSddl(p).Contains("(D;;GA;;;NU)") && !PipeSddl(p).Contains(";;;WD)"));
        try{ValidateDeployment();assert(false);}catch(InvalidDataException){}
        var restored=ParsePolicy(sid+"|0|7");assert(!restored.Enabled && restored.Owner==sid && restored.Generation==7);
        try{ParsePolicy(sid+"|1|bad");assert(false);}catch(InvalidDataException){}
        ValidateServiceAcl(new RawSecurityDescriptor("O:SYG:SYD:P(A;;GA;;;SY)(A;;GA;;;BA)"));
        try{ValidateServiceAcl(new RawSecurityDescriptor("O:SYG:SYD:P(A;;GA;;;WD)"));assert(false);}catch(InvalidDataException){}
        var processAcl=new RawSecurityDescriptor(ProcessQuerySddl(sid));
        foreach(GenericAce entry in processAcl.DiscretionaryAcl) {
            var ace=(QualifiedAce)entry;
            if(ace.SecurityIdentifier.Value==sid)assert(ace.AccessMask==0x1000);
            else assert(PrivilegedSid(ace.SecurityIdentifier.Value));
        }
        assert(!ProcessQuerySddl("").Contains("0x1000"));
        Console.WriteLine("PASS: policy, authorization, revocation, replay, failure, ACL and protected deployment checks");return 0;
    }
    static int Main(string[] args) {
        try {
            // Pure policy tests only; cannot register a service, write policy or run an action.
            if(args.Length==1 && args[0]=="--self-test") {LifecycleSelfTest();return SelfTest();}
            ValidateDeployment();
            if(args.Length==2 && args[0]=="--provision" && ValidOwner(args[1]) && ElevatedInteractive())return Provision(args[1]);
            if(args.Length==1 && args[0]=="--prepare-package-update" && ElevatedInteractive())return PreparePackageUpdate();
            if(args.Length==1 && args[0]=="--remove" && ElevatedInteractive())return RemoveFoundation();
            if(args.Length==0) {ServiceBase.Run(new MaintenanceFoundation());return 0;}
            if(args.Length==1 && (args[0]=="--status" || args[0]=="--revoke"))return Client(args[0]=="--status"?"status":"revoke",null);
            if(args.Length==2 && (args[0]=="--run" || args[0]=="--execute") && ValidAction(args[1]))return Client(args[1],null);
            if(args.Length==1 && (args[0]=="--request-enrollment" || args[0]=="--request-provision" || args[0]=="--request-removal")) {
                string sid=WindowsIdentity.GetCurrent().User.Value;if(!ValidOwner(sid) || !Environment.UserInteractive)return 1;
                using(var approved=Process.Start(new ProcessStartInfo(Image,args[0]=="--request-removal"?"--remove":(args[0]=="--request-provision"?"--provision ":"--enroll ")+sid){UseShellExecute=true,Verb="runas",WorkingDirectory=Root})) {approved.WaitForExit(90000);if(!approved.HasExited){Console.WriteLine("provisioning-incomplete");return 1;}if(approved.ExitCode!=0){Console.WriteLine("unavailable");return 1;}if(args[0]=="--request-removal"){Console.WriteLine("removed");return 0;}return Client("status",null);}
            }
            if(args.Length==2 && args[0]=="--enroll" && ValidOwner(args[1]) && Environment.UserInteractive && new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator))return Client("enroll",args[1]);
            return 2;
        }catch(System.ComponentModel.Win32Exception error){Console.WriteLine(error.NativeErrorCode==1223?"uac-cancelled":"unavailable");return 1;}catch{Console.WriteLine("unavailable");return 1;}
    }
}