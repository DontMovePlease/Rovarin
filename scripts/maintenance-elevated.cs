// Fixed, one-shot maintenance UAC broker/worker. No commands, paths or script text are accepted.
using System;
using System.IO;
using System.IO.Pipes;
using System.Diagnostics;
using System.ComponentModel;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Collections.Generic;
using Microsoft.Win32.SafeHandles;

internal static class RovarinMaintenance {
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 8192 };
    static readonly object OutputLock = new object();
    static readonly string[] Allowed = { "windows_repair", "sfc_scan", "dism_check", "reset_network", "clear_dns" };
    static IntPtr job;
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr handle,int type,ref JobLimits limits,int length);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr handle,IntPtr process);
    [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr handle,uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe,out uint pid);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe,out uint pid);
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process,int kind,ref ProcessBasic info,int size,out int returned);
    [StructLayout(LayoutKind.Sequential)] struct ProcessBasic { public IntPtr ExitStatus,Peb,Affinity,Priority,Pid,Parent; }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits { public long ProcessTime,JobTime; public uint Flags; public UIntPtr MinWorking,MaxWorking; public uint Active; public UIntPtr Affinity; public uint Priority,Scheduling; }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOperations,WriteOperations,OtherOperations,ReadBytes,WriteBytes,OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct JobLimits { public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory,JobMemory,PeakProcess,PeakJob; }
    static bool Valid(string action) { return Array.IndexOf(Allowed,action)>=0; }
    static void Emit(object value) { lock(OutputLock) Console.WriteLine(Json.Serialize(value)); }
    static object Result(string action,bool success,string code,string summary,int? exitCode=null) {
        return new { type="result",action=action,success=success,code=code,summary=summary,exitCode=exitCode };
    }
    static int Main(string[] args) {
        try {
            if(args.Length==2 && Valid(args[0])) {
                int parent; if(!Int32.TryParse(args[1],out parent) || parent<1) return 2;
                ProcessBasic info=new ProcessBasic();int returned;
                if(NtQueryInformationProcess(Process.GetCurrentProcess().Handle,0,ref info,Marshal.SizeOf(info),out returned)!=0 || info.Parent.ToInt64()!=parent) return 2;
                return Broker(args[0],Process.GetProcessById(parent));
            }
            if(args.Length==4 && args[0]=="--worker" && Valid(args[1])) {
                Guid guid;int broker;
                if(!Guid.TryParseExact(args[2],"N",out guid) || !Int32.TryParse(args[3],out broker) || broker<1) return 2;
                return Worker(args[1],args[2],broker);
            }
            Emit(Result("",false,"invalid-action","Unsupported maintenance action."));return 2;
        } catch { Emit(Result(args.Length>0 && Valid(args[0])?args[0]:"",false,"helper-failed","The maintenance helper could not complete safely."));return 1; }
    }
    static int Broker(string action,Process parent) {
        string nonce=Guid.NewGuid().ToString("N");
        var security=new PipeSecurity();security.SetAccessRuleProtection(true,false);
        security.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User,PipeAccessRights.FullControl,AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid,null),PipeAccessRights.ReadWrite,AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid,null),PipeAccessRights.FullControl,AccessControlType.Deny));
        // A held parent process identity cannot be confused with a reused PID.
        DateTime deadline=DateTime.UtcNow.AddMinutes(2);
        using(var pipe=new NamedPipeServerStream("RovarinMaintenance-"+nonce,PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous,8192,8192,security))
        using(var guard=new Timer(delegate {
            try { if(parent.HasExited) Environment.Exit(3); if(DateTime.UtcNow>deadline) { Emit(Result(action,false,"timeout","Administrator approval or maintenance execution timed out.")); Environment.Exit(3); } } catch { Environment.Exit(3); }
        },null,250,250)) {
            Emit(new {type="progress",action=action,step=0,total=1,message="Waiting for administrator approval on this PC…"});
            Process elevated;
            try {
                elevated=Process.Start(new ProcessStartInfo {
                    FileName=System.Reflection.Assembly.GetExecutingAssembly().Location,
                    Arguments="--worker "+action+" "+nonce+" "+Process.GetCurrentProcess().Id,
                    UseShellExecute=true,Verb="runas",WindowStyle=ProcessWindowStyle.Hidden,
                    WorkingDirectory=Environment.SystemDirectory
                });
            } catch(Win32Exception error) {
                bool cancelled=error.NativeErrorCode==1223;
                Emit(Result(action,false,cancelled?"uac-cancelled":"launch-failed",cancelled?"Administrator approval was cancelled.":"Windows could not start the administrator-approved action.",error.NativeErrorCode));return cancelled?0:1;
            }
            using(elevated) {
                var connected=pipe.BeginWaitForConnection(null,null);
                var connectDeadline=DateTime.UtcNow.AddSeconds(20);
                while(!connected.AsyncWaitHandle.WaitOne(100)) {
                    if(elevated.HasExited) {Emit(Result(action,false,"helper-failed","The elevated helper could not establish its protected operation context.",elevated.ExitCode));return 1;}
                    if(DateTime.UtcNow>connectDeadline) {Emit(Result(action,false,"connection-failed","The elevated helper did not connect; no action was authorized."));return 1;}
                }
                pipe.EndWaitForConnection(connected);
                uint client;
                if(!GetNamedPipeClientProcessId(pipe.SafePipeHandle,out client) || client!=(uint)elevated.Id) { Emit(Result(action,false,"identity-mismatch","Maintenance helper identity could not be verified."));return 1; }
                deadline=DateTime.UtcNow.AddMinutes(31);
                using(var writer=new StreamWriter(pipe,new System.Text.UTF8Encoding(false),8192,true) {AutoFlush=true})
                using(var reader=new StreamReader(pipe,new System.Text.UTF8Encoding(false),false,8192,true)) {
                    writer.WriteLine("GO");
                    int count=0;bool result=false;string line;
                    while((line=reader.ReadLine())!=null) {
                        if(line.Length>8192 || ++count>600) throw new InvalidDataException();
                        var value=Json.Deserialize<Dictionary<string,object>>(line);
                        if(!value.ContainsKey("action") || !action.Equals(value["action"]) || !value.ContainsKey("type")) throw new InvalidDataException();
                        Emit(value);
                        if("result".Equals(value["type"])) {result=true;break;}
                    }
                    if(!result) {Emit(Result(action,false,"helper-crashed","The elevated helper stopped before confirming completion."));return 1;}
                }
                pipe.Dispose(); // release the worker lifetime monitor before awaiting its exit
                if(!elevated.WaitForExit(5000)) { Emit(Result(action,false,"shutdown-unconfirmed","The elevated helper did not confirm shutdown."));return 1; }
                return elevated.ExitCode==0?0:1;
            }
        }
    }
    static int Worker(string action,string nonce,int broker) {
        if(!new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator)) return 2;
        // Put THIS worker in a kill-on-close job before any tool is created.
        // Its fixed system-tool children inherit the job, including on crashes.
        job=CreateJobObject(IntPtr.Zero,null);
        var limits=new JobLimits();limits.Basic.Flags=0x2000;
        if(job==IntPtr.Zero || !SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(limits)) || !AssignProcessToJobObject(job,Process.GetCurrentProcess().Handle)) return 2;
        using(var pipe=new NamedPipeClientStream(".","RovarinMaintenance-"+nonce,PipeDirection.InOut,PipeOptions.Asynchronous,TokenImpersonationLevel.Identification)) {
            pipe.Connect(20000);uint server;
            if(!GetNamedPipeServerProcessId(pipe.SafePipeHandle,out server) || server!=(uint)broker) return 2;
            using(var writer=new StreamWriter(pipe,new System.Text.UTF8Encoding(false),8192,true) {AutoFlush=true})
            using(var reader=new StreamReader(pipe,new System.Text.UTF8Encoding(false),false,8192,true)) {
                if(reader.ReadLine()!="GO") return 2;
                // Losing the unelevated broker/backend cancels only this owned job.
                int workerFinished=0;
                var disconnected=new Thread(delegate() { try {reader.ReadLine();}catch {} if(Interlocked.CompareExchange(ref workerFinished,0,0)==0) TerminateJobObject(job,3); });disconnected.IsBackground=true;disconnected.Start();
                Action<object> send=delegate(object value) {lock(OutputLock) { if("result".Equals(value.GetType().GetProperty("type").GetValue(value,null))) Interlocked.Exchange(ref workerFinished,1); writer.WriteLine(Json.Serialize(value)); }};
                using(var timeout=new Timer(delegate {
                    try { send(Result(action,false,"timeout","The elevated maintenance action timed out.")); } catch {}
                    TerminateJobObject(job,3);
                },null,30*60*1000,Timeout.Infinite)) {
                    string[][] commands;
                    switch(action) {
                        case "windows_repair":commands=new[]{new[]{"dism.exe","/online /cleanup-image /checkhealth"},new[]{"dism.exe","/online /cleanup-image /scanhealth"},new[]{"dism.exe","/online /cleanup-image /restorehealth"},new[]{"sfc.exe","/scannow"}};break;
                        case "sfc_scan":commands=new[]{new[]{"sfc.exe","/scannow"}};break;
                        case "dism_check":commands=new[]{new[]{"dism.exe","/online /cleanup-image /checkhealth"},new[]{"dism.exe","/online /cleanup-image /scanhealth"}};break;
                        case "clear_dns":commands=new[]{new[]{"ipconfig.exe","/flushdns"}};break;
                        case "reset_network":commands=new[]{new[]{"netsh.exe","winsock reset"},new[]{"netsh.exe","int ip reset"}};break;
                        default:return 2;
                    }
                    int lines=0;var sfcText=new System.Text.StringBuilder();
                    int netshOk=0,netshFail=0;bool netshReboot=false;
                    for(int i=0;i<commands.Length;i++) {
                        string tool=Path.Combine(Environment.SystemDirectory,commands[i][0]);
                        if(!File.Exists(tool)) {send(Result(action,false,"tool-unavailable","The required Windows maintenance tool is unavailable."));return 1;}
                        send(new {type="progress",action=action,step=i+1,total=commands.Length,message="Running "+commands[i][0]+" (step "+(i+1)+" of "+commands.Length+")"});
                        using(var child=new Process()) {
                            child.StartInfo=new ProcessStartInfo(tool,commands[i][1]) {UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true,WorkingDirectory=Environment.SystemDirectory};
                            child.StartInfo.EnvironmentVariables.Remove("__COMPAT_LAYER");
                            if(commands[i][0]=="sfc.exe") child.StartInfo.StandardOutputEncoding=System.Text.Encoding.Unicode;
                            DataReceivedEventHandler output=delegate(object sender,DataReceivedEventArgs e) {
                                if(!String.IsNullOrWhiteSpace(e.Data)) {
                                    string text=e.Data.Replace("\0","");
                                    if(commands[i][0]=="sfc.exe") lock(OutputLock) { if(sfcText.Length<16000) sfcText.Append(text).Append(" "); }
                                    if(action=="reset_network") {
                                        if(text.Contains(", OK!") || text.IndexOf("Successfully reset",StringComparison.OrdinalIgnoreCase)>=0 || text.IndexOf("Sucessfully reset",StringComparison.OrdinalIgnoreCase)>=0) Interlocked.Increment(ref netshOk);
                                        if(text.Contains(", failed.") || text.IndexOf("Access is denied",StringComparison.OrdinalIgnoreCase)>=0) Interlocked.Increment(ref netshFail);
                                        if(text.IndexOf("restart the computer",StringComparison.OrdinalIgnoreCase)>=0) netshReboot=true;
                                    }
                                    if(Interlocked.Increment(ref lines)<=500) send(new {type="log",action=action,message=text.Length>2000?text.Substring(0,2000):text});
                                }
                            };
                            child.OutputDataReceived+=output;child.ErrorDataReceived+=output;
                            try {child.Start();child.BeginOutputReadLine();child.BeginErrorReadLine();child.WaitForExit();}
                            catch {send(Result(action,false,"tool-failed","A Windows maintenance tool could not run."));return 1;}
                            if(child.ExitCode!=0) {
                                if(action=="reset_network" && commands[i][0]=="netsh.exe" && commands[i][1]=="int ip reset" && netshOk>0 && netshReboot) {
                                    // Partial completion allowed only when Winsock + compartments succeeded and reboot was requested.
                                } else {
                                    send(Result(action,false,"operation-failed","Windows maintenance failed at step "+(i+1)+" (exit "+child.ExitCode+").",child.ExitCode));return 1;
                                }
                            }
                        }
                    }
                    string sfc=sfcText.ToString().ToLowerInvariant();
                    if(sfc.Contains("unable to fix some of them") || sfc.Contains("found corrupt files but was unable to fix")) {send(Result(action,false,"operation-failed","SFC found corruption it could not repair. Review CBS.log.",0));return 1;}
                    if(action=="reset_network") {
                        if(netshFail>0 && netshOk>0 && netshReboot) {
                            send(Result(action,false,"partially-completed","Network reset partially completed (some protected system settings require restart). Restart your PC to finish applying it.",0));
                            return 0;
                        }
                        if(netshFail>0 || !netshReboot || netshOk==0) {
                            send(Result(action,false,"operation-failed","Network reset could not complete successfully.",1));
                            return 1;
                        }
                        send(Result(action,true,"completed","Network reset completed. Restart your PC to finish applying it.",0));
                        return 0;
                    }
                    send(Result(action,true,"completed","Windows maintenance completed successfully.",0));
                    return 0;
                }
            }
        }
    }
}
