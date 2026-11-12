// One-shot, fixed startup-approval broker. Never executes a startup command,
// changes a registration, or accepts a filesystem/registry destination.
using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Diagnostics;
using System.ComponentModel;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Security.AccessControl;
using System.Runtime.InteropServices;
using System.Threading;
using System.Management;
using System.Web.Script.Serialization;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

public static class RovarinStartupApproval {
    static readonly JavaScriptSerializer Json=new JavaScriptSerializer {MaxJsonLength=8192};
    const string Run="Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    const string Approval="Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\";
    static bool catalogAttempted,catalogKnown;
    static readonly List<string> securityDirectories=new List<string>();
    sealed class Entry : IDisposable {
        public string Source,Key,Fingerprint,Kind;
        public FileStream Held;
        public void Dispose(){if(Held!=null)Held.Dispose();}
    }
    public static string Hash(string value){using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(value))).Replace("-","").ToLowerInvariant();}
    static bool Source(string source){return source=="registry-machine"||source=="registry-machine32"||source=="folder-machine"||source=="scheduled-task";}
    static void SafePath(string path){for(string p=Path.GetFullPath(path);!String.IsNullOrEmpty(p);p=Path.GetDirectoryName(p)){if((Directory.Exists(p)||File.Exists(p))&&(File.GetAttributes(p)&FileAttributes.ReparsePoint)!=0)throw new InvalidDataException();}}
    static string Executable(string command){
        string value=Environment.ExpandEnvironmentVariables(command??"").Trim();
        if(value.StartsWith("\"")){int end=value.IndexOf('"',1);return end>1?value.Substring(1,end-1):null;}
        // Do not guess executable boundaries in an ambiguous unquoted command.
        int space=value.IndexOf(' ');string candidate=space<0?value:value.Substring(0,space);
        return Path.IsPathRooted(candidate)&&File.Exists(candidate)?candidate:null;
    }
    static void OrdinaryExecutable(string exe,string key){
        if(String.IsNullOrEmpty(exe)||!Path.IsPathRooted(exe)||!exe.EndsWith(".exe",StringComparison.OrdinalIgnoreCase)||!File.Exists(exe))throw new InvalidDataException("Application target is unavailable or ambiguous");
        exe=Path.GetFullPath(exe);SafePath(exe);
        string windows=Environment.GetFolderPath(Environment.SpecialFolder.Windows).TrimEnd('\\')+"\\";
        string names=(key+"|"+exe).ToLowerInvariant();
        if(exe.StartsWith(windows,StringComparison.OrdinalIgnoreCase)||System.Text.RegularExpressions.Regex.IsMatch(names,"securityhealth|defender|antivirus|antimalware|endpoint|reasonlabs|rovarin"))throw new InvalidDataException("Protected Windows, security or Rovarin startup");
        // A label alone cannot rule out security software. Consult both native
        // Security Center catalogs; unavailable protection coverage fails closed.
        if(!catalogAttempted){catalogAttempted=true;foreach(string cls in new[]{"AntiVirusProduct","FirewallProduct"}){
            using(var search=new ManagementObjectSearcher("root\\SecurityCenter2","SELECT * FROM "+cls)){
                search.Options.Timeout=TimeSpan.FromSeconds(2);
                using(var products=search.Get())foreach(ManagementObject product in products){
                    bool resolved=false;
                    foreach(string property in new[]{"pathToSignedProductExe","pathToSignedReportingExe"}){
                        string raw=Convert.ToString(product[property]);if(String.IsNullOrEmpty(raw))continue;
                        var match=System.Text.RegularExpressions.Regex.Match(Environment.ExpandEnvironmentVariables(raw),"^[\"']?(?<exe>[A-Za-z]:\\\\.+?\\.exe)(?:[\"']|\\s|$)",System.Text.RegularExpressions.RegexOptions.IgnoreCase);
                        if(!match.Success)continue;resolved=true;
                        string directory=Path.GetDirectoryName(match.Groups["exe"].Value).TrimEnd('\\')+"\\";
                        securityDirectories.Add(directory);
                    }
                    if(!resolved)throw new InvalidDataException("Security software protection is unavailable");
                }
            }
        }catalogKnown=true;}
        if(!catalogKnown)throw new InvalidDataException("Security software protection is unavailable");
        foreach(string directory in securityDirectories)if(exe.StartsWith(directory,StringComparison.OrdinalIgnoreCase))throw new InvalidDataException("Registered security software startup");
    }
    static Entry Resolve(string source,string key){
        if(!Source(source)||String.IsNullOrEmpty(key)||key.Length>1024||key.IndexOfAny(new[]{'\0','\r','\n'})>=0)throw new InvalidDataException("Unsupported startup identity");
        var entry=new Entry {Source=source,Key=key,Kind=source=="registry-machine32"?"Run32":"Run"};
        try{
            if(source=="folder-machine"){
                if(key!=Path.GetFileName(key)||key.IndexOfAny(Path.GetInvalidFileNameChars())>=0||!key.EndsWith(".lnk",StringComparison.OrdinalIgnoreCase))throw new InvalidDataException("Only ordinary Startup shortcuts are supported");
                string path=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonStartup),key);SafePath(path);
                entry.Held=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read);
                var file=new FileInfo(path);entry.Fingerprint=Hash("folder-machine|"+key+"|"+file.Length+"|"+file.LastWriteTimeUtc.Ticks);entry.Kind="StartupFolder";
                Type type=Type.GetTypeFromProgID("WScript.Shell");dynamic shell=Activator.CreateInstance(type);dynamic shortcut=null;
                try{shortcut=shell.CreateShortcut(path);OrdinaryExecutable(Convert.ToString(shortcut.TargetPath),key);}finally{if(shortcut!=null)Marshal.FinalReleaseComObject(shortcut);Marshal.FinalReleaseComObject(shell);}
            }else{
                using(var hive=RegistryKey.OpenBaseKey(RegistryHive.LocalMachine,source=="registry-machine32"?RegistryView.Registry32:RegistryView.Registry64))
                using(var run=hive.OpenSubKey(Run)){
                    if(run==null)throw new InvalidDataException("Startup registration is unavailable");
                    var kind=run.GetValueKind(key);if(kind!=RegistryValueKind.String&&kind!=RegistryValueKind.ExpandString)throw new InvalidDataException("Unsupported Run value type");
                    string command=run.GetValue(key) as string;entry.Fingerprint=Hash(source+"|"+key+"|"+command);OrdinaryExecutable(Executable(command),key);
                }
            }
            return entry;
        }catch{entry.Dispose();throw;}
    }
    static byte[] Read(RegistryKey key,string name){
        object value=key==null?null:key.GetValue(name,null,RegistryValueOptions.DoNotExpandEnvironmentNames);
        if(value==null)return null;if(key.GetValueKind(name)!=RegistryValueKind.Binary)throw new InvalidDataException("Unknown Windows approval data");return (byte[])value;
    }
    static bool State(byte[] bytes){if(bytes==null)return true;if(bytes.Length>=12){if(bytes[0]==2||bytes[0]==6)return true;if(bytes[0]==3||bytes[0]==7)return false;}throw new InvalidDataException("Unknown Windows approval state");}
    static bool Equal(byte[] a,byte[] b){if(a==null||b==null)return a==b;if(a.Length!=b.Length)return false;for(int i=0;i<a.Length;i++)if(a[i]!=b[i])return false;return true;}
    // Task Scheduler changes only Enabled. It never registers a replacement,
    // changes principal/actions/triggers/ACLs, or starts the task.
    sealed class StartupTaskEntry : IDisposable {
        public dynamic Scheduler,Task;
        public string Path,Fingerprint,Identity,Scope;
        public bool Enabled;
        public FileStream Held;
        public void Dispose(){if(Held!=null)Held.Dispose();if(Task!=null)Marshal.FinalReleaseComObject(Task);if(Scheduler!=null)Marshal.FinalReleaseComObject(Scheduler);}
    }
    static string Sid(string account){if(String.IsNullOrEmpty(account))return "";return account.StartsWith("S-1-",StringComparison.OrdinalIgnoreCase)?new SecurityIdentifier(account).Value:((SecurityIdentifier)new NTAccount(account).Translate(typeof(SecurityIdentifier))).Value;}
    static readonly string TrustedInstaller="S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
    static bool TrustedOwner(string sid){return sid=="S-1-5-18"||sid=="S-1-5-32-544"||sid==TrustedInstaller;}
    static void ProtectedTaskPath(string path){
        string programRoot=null;
        foreach(string candidate in new[]{Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86)})if(!String.IsNullOrEmpty(candidate)&&path.StartsWith(candidate.TrimEnd('\\')+"\\",StringComparison.OrdinalIgnoreCase))programRoot=candidate;
        if(programRoot==null)throw new InvalidDataException("Administrator task paths must be protected installed application locations");
        SafePath(path);
        for(string p=path;p.Length>=programRoot.Length;p=System.IO.Path.GetDirectoryName(p)){
            FileSystemSecurity permissions=File.Exists(p)?File.GetAccessControl(p):(FileSystemSecurity)Directory.GetAccessControl(p);
            if(!TrustedOwner(permissions.GetOwner(typeof(SecurityIdentifier)).Value))throw new InvalidDataException("Task path ownership is not protected");
            foreach(FileSystemAccessRule rule in permissions.GetAccessRules(true,true,typeof(SecurityIdentifier)))if(rule.AccessControlType==AccessControlType.Allow&&!TrustedOwner(rule.IdentityReference.Value)&&(rule.FileSystemRights&(FileSystemRights.Write|FileSystemRights.Delete|FileSystemRights.DeleteSubdirectoriesAndFiles|FileSystemRights.ChangePermissions|FileSystemRights.TakeOwnership))!=0)throw new InvalidDataException("Task path is writable outside trusted administrators");
        }
    }
    static string DefinitionIdentity(string path,string xml,string security){
        // Windows omits the default Enabled=true element and its indentation.
        // Ignore XML formatting, while retaining every other definition value.
        var doc=new System.Xml.XmlDocument {XmlResolver=null,PreserveWhitespace=false};doc.LoadXml(xml);
        var state=doc.SelectSingleNode("/*[local-name()='Task']/*[local-name()='Settings']/*[local-name()='Enabled']");
        if(state!=null)state.ParentNode.RemoveChild(state);
        return Hash(path+"|"+doc.OuterXml+"|"+security);
    }
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]struct TrustFile {public uint Size;[MarshalAs(UnmanagedType.LPWStr)]public string Path;public IntPtr File,Subject;}
    [StructLayout(LayoutKind.Sequential)]struct TrustData {public uint Size;public IntPtr Callback,Sip;public uint Ui,Revocation,Choice;public IntPtr File;public uint Action;public IntPtr State,Url;public uint Flags,Context;public IntPtr Signature;}
    [DllImport("wintrust.dll",ExactSpelling=true)]static extern int WinVerifyTrust(IntPtr window,ref Guid action,ref TrustData data);
    static bool TrustedSignature(string path,FileStream held){
        var file=new TrustFile {Size=(uint)Marshal.SizeOf(typeof(TrustFile)),Path=path,File=held.SafeFileHandle.DangerousGetHandle()};
        IntPtr pointer=Marshal.AllocHGlobal(Marshal.SizeOf(file));Marshal.StructureToPtr(file,pointer,false);
        var data=new TrustData {Size=(uint)Marshal.SizeOf(typeof(TrustData)),Ui=2,Choice=1,File=pointer,Action=1,Flags=0x1000};
        var action=new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");
        try{return WinVerifyTrust(new IntPtr(-1),ref action,ref data)==0;}
        finally{data.Action=2;WinVerifyTrust(new IntPtr(-1),ref action,ref data);Marshal.DestroyStructure(pointer,typeof(TrustFile));Marshal.FreeHGlobal(pointer);}
    }
    static StartupTaskEntry ResolveTask(string path,string caller){
        if(String.IsNullOrEmpty(path)||!path.StartsWith("\\")||path.Length>1024||System.Text.RegularExpressions.Regex.IsMatch(path,"[\\x00-\\x1f]|(?i)^\\\\Microsoft(?:\\\\|$)|rovarin|defender|antivirus|antimalware|security|endpoint|firewall|reasonlabs"))throw new InvalidDataException("Protected Windows, security or Rovarin task");
        var entry=new StartupTaskEntry {Path=path};
        try{
            entry.Scheduler=Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service"));entry.Scheduler.Connect();
            dynamic folder=entry.Scheduler.GetFolder("\\");try{entry.Task=folder.GetTask(path);}finally{Marshal.FinalReleaseComObject(folder);}
            dynamic definition=entry.Task.Definition,principal=definition.Principal;
            int logon=(int)principal.LogonType;
            bool user=logon==3&&Sid(Convert.ToString(principal.UserId))==caller;
            string group=Sid(Convert.ToString(principal.GroupId));
            bool ordinaryGroup=logon==4&&(group=="S-1-5-32-545"||group=="S-1-5-4");
            if(!user&&!ordinaryGroup)throw new InvalidDataException("Different-user, administrator-group or service-account task is protected");
            entry.Scope=ordinaryGroup?"machine":"user";
            string security=Convert.ToString(entry.Task.GetSecurityDescriptor(5));var acl=new RawSecurityDescriptor(security);
            if(acl.DiscretionaryAcl==null||acl.Owner==null||(!TrustedOwner(acl.Owner.Value)&&acl.Owner.Value!=caller))throw new InvalidDataException("Task ownership could not be verified");
            foreach(GenericAce raw in acl.DiscretionaryAcl){var ace=raw as QualifiedAce;if(ace==null)throw new InvalidDataException("Unsupported task permissions");if(ace.AceQualifier==AceQualifier.AccessAllowed&&!TrustedOwner(ace.SecurityIdentifier.Value)&&ace.SecurityIdentifier.Value!=caller&&(ace.AccessMask&0x500d0116)!=0)throw new InvalidDataException("Task is writable by another account");}
            dynamic triggers=definition.Triggers;
            if((int)triggers.Count<1)throw new InvalidDataException("Task has no startup trigger");
            for(int i=1;i<=(int)triggers.Count;i++){dynamic trigger=triggers.Item(i);int type=(int)trigger.Type;
                if(type!=8&&type!=9)throw new InvalidDataException("Task also has non-startup triggers; use Task Scheduler");
                if(type==9){string who=Convert.ToString(trigger.UserId);if(!String.IsNullOrEmpty(who)&&Sid(who)!=caller)throw new InvalidDataException("Task targets another user's sign-in");}}
            dynamic actions=definition.Actions;
            if((int)actions.Count!=1||(int)actions.Item(1).Type!=0)throw new InvalidDataException("Only a single executable startup action is supported");
            string exe=Environment.ExpandEnvironmentVariables(Convert.ToString(actions.Item(1).Path)).Trim().Trim('"');
            if(System.Text.RegularExpressions.Regex.IsMatch(System.IO.Path.GetFileName(exe),"(?i)^(powershell|pwsh|cmd|wscript|cscript|rundll32|regsvr32|mshta|msiexec|node|python.*|dotnet|java.*|bash|sh|git-bash)\\.exe$"))throw new InvalidDataException("Script/interpreter tasks require Task Scheduler");
            OrdinaryExecutable(exe,path);
            exe=System.IO.Path.GetFullPath(exe);ProtectedTaskPath(exe);
            string working=Environment.ExpandEnvironmentVariables(Convert.ToString(actions.Item(1).WorkingDirectory)??"").Trim().Trim('"');
            if(!String.IsNullOrEmpty(working)){
                if(!System.IO.Path.IsPathRooted(working))throw new InvalidDataException("Relative task working directory is not supported");
                ProtectedTaskPath(System.IO.Path.GetFullPath(working));
            }
            entry.Held=new FileStream(exe,FileMode.Open,FileAccess.Read,FileShare.Read);
            if(!TrustedSignature(exe,entry.Held))throw new InvalidDataException("Task application signature could not be verified");
            var info=FileVersionInfo.GetVersionInfo(exe);if(System.Text.RegularExpressions.Regex.IsMatch(info.CompanyName??"","(?i)security|antivirus|antimalware"))throw new InvalidDataException("Protected security application task");
            string xml=Convert.ToString(entry.Task.Xml);if(xml.Length>262144)throw new InvalidDataException("Task definition exceeds the supported bound");
            entry.Enabled=Convert.ToBoolean(entry.Task.Enabled);entry.Fingerprint=Hash(path+"|"+xml);entry.Identity=DefinitionIdentity(path,xml,security);
            return entry;
        }catch{entry.Dispose();throw;}
    }
    static object ApplyTask(Dictionary<string,object> r){
        string path=(string)r["key"],caller=r.ContainsKey("callerSid")?(string)r["callerSid"]:WindowsIdentity.GetCurrent().User.Value;bool desired=(bool)r["enabled"];
        using(var entry=ResolveTask(path,caller)){
            if(entry.Fingerprint!=(string)r["fingerprint"])return new{success=false,code="startup-changed"};
            using(var fresh=ResolveTask(path,caller)){if(fresh.Fingerprint!=entry.Fingerprint||fresh.Identity!=entry.Identity)return new{success=false,code="startup-changed"};}
            try{
                entry.Task.Enabled=desired;
                using(var after=ResolveTask(path,caller)){
                    if(after.Enabled!=desired||after.Identity!=entry.Identity)return new{success=false,code="startup-changed"};
                    return new{success=true,code="completed",enabled=after.Enabled};
                }
            }catch{return new{success=false,code="startup-changed"};}
        }
    }
    public static string Inspect(string source,string key){
        if(source=="scheduled-task"){
            try{using(var task=ResolveTask(key,WindowsIdentity.GetCurrent().User.Value))return Json.Serialize(new{manageable=true,requiresElevation=true,enabled=task.Enabled,scope=task.Scope,reason="Local Windows administrator approval required"});}
            catch(Exception e){return Json.Serialize(new{manageable=false,requiresElevation=false,reason=e is InvalidDataException?e.Message:"Windows task permissions or application protection could not be verified"});}
        }
        try{using(var entry=Resolve(source,key))using(var hive=RegistryKey.OpenBaseKey(RegistryHive.LocalMachine,RegistryView.Registry64))using(var approval=hive.OpenSubKey(Approval+entry.Kind))return Json.Serialize(new {manageable=true,requiresElevation=true,enabled=State(Read(approval,key)),reason="Local Windows administrator approval required; affects all users"});}
        catch(Exception e){return Json.Serialize(new {manageable=false,requiresElevation=false,reason=e is InvalidDataException?e.Message:"Windows startup permissions or protection could not be verified"});}
    }
    static Dictionary<string,object> Request(string line,bool fromBroker=false){
        var r=Json.Deserialize<Dictionary<string,object>>(line);
        if(r.Count!=(fromBroker?5:4)||!r.ContainsKey("source")||!r.ContainsKey("key")||!r.ContainsKey("fingerprint")||!r.ContainsKey("enabled")||!(r["source"] is string)||!(r["key"] is string)||!(r["enabled"] is bool)||!(r["fingerprint"] is string)||!System.Text.RegularExpressions.Regex.IsMatch((string)r["fingerprint"],"^[a-f0-9]{64}$")||!Source((string)r["source"]))throw new InvalidDataException();
        if(fromBroker&&(!r.ContainsKey("callerSid")||!(r["callerSid"] is string)||Sid((string)r["callerSid"])!=(string)r["callerSid"]))throw new InvalidDataException();return r;
    }
    static object Apply(Dictionary<string,object> r){
        if((string)r["source"]=="scheduled-task")return ApplyTask(r);
        string source=(string)r["source"],name=(string)r["key"];bool enabled=(bool)r["enabled"];
        using(var entry=Resolve(source,name)){
            if(entry.Fingerprint!=(string)r["fingerprint"])return new {success=false,code="startup-changed"};
            using(var hive=RegistryKey.OpenBaseKey(RegistryHive.LocalMachine,RegistryView.Registry64))
            using(var key=hive.CreateSubKey(Approval+entry.Kind)){
                byte[] original=Read(key,name);State(original);
                byte[] desired=new byte[12];desired[0]=(byte)(enabled?2:3);if(!enabled)Array.Copy(BitConverter.GetBytes(DateTime.UtcNow.ToFileTimeUtc()),0,desired,4,8);
                // Registration and approval are checked again immediately before
                // the one atomic value write. Never delete/move a Run/lnk entry.
                using(var fresh=Resolve(source,name)){if(fresh.Fingerprint!=entry.Fingerprint||!Equal(original,Read(key,name)))return new {success=false,code="startup-changed"};}
                try{
                    key.SetValue(name,desired,RegistryValueKind.Binary);key.Flush();
                    using(var fresh=Resolve(source,name)){if(!Equal(Read(key,name),desired)||fresh.Fingerprint!=entry.Fingerprint)throw new InvalidDataException();}
                    return new {success=true,code="completed",enabled=enabled};
                }catch{
                    // Restore only our own exact bytes, preserving any outside
                    // writer. A failed/uncertain rollback is never success.
                    bool restored=false;
                    try{if(Equal(Read(key,name),desired)){if(original==null)key.DeleteValue(name,false);else key.SetValue(name,original,RegistryValueKind.Binary);key.Flush();restored=Equal(Read(key,name),original);}}catch{}
                    return new {success=false,code="startup-changed",rollbackConfirmed=restored};
                }
            }
        }
    }
    [DllImport("kernel32.dll",SetLastError=true)]static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe,out uint pid);
    [DllImport("kernel32.dll",SetLastError=true)]static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe,out uint pid);
    [DllImport("ntdll.dll")]static extern int NtQueryInformationProcess(IntPtr process,int kind,ref Basic info,int size,out int returned);
    [StructLayout(LayoutKind.Sequential)]struct Basic{public IntPtr ExitStatus,Peb,Affinity,Priority,Pid,Parent;}
    static string Line(StreamReader reader){var b=new StringBuilder();int c;while((c=reader.Read())>=0){if(c=='\n')return b.ToString().TrimEnd('\r');if(b.Length>=8192)throw new InvalidDataException();b.Append((char)c);}throw new EndOfStreamException();}
    static void Emit(object result){Console.WriteLine(Json.Serialize(result));Console.Out.Flush();}
    static bool Admin(){return new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator);}
    static string Self(){return Path.GetFullPath(System.Reflection.Assembly.GetExecutingAssembly().Location);}
    static void PrivateBinary(){
        string self=Self();SafePath(self);string sid=WindowsIdentity.GetCurrent().User.Value;
        foreach(string p in new[]{self,Path.GetDirectoryName(self)}){
            var acl=File.Exists(p)?File.GetAccessControl(p):(FileSystemSecurity)Directory.GetAccessControl(p);
            if(acl.GetOwner(typeof(SecurityIdentifier)).Value!=sid)throw new InvalidDataException();
            foreach(FileSystemAccessRule rule in acl.GetAccessRules(true,true,typeof(SecurityIdentifier)))if(rule.AccessControlType==AccessControlType.Allow&&rule.IdentityReference.Value!=sid&&rule.IdentityReference.Value!="S-1-5-18"&&rule.IdentityReference.Value!="S-1-5-32-544"&&(rule.FileSystemRights&(FileSystemRights.Write|FileSystemRights.Delete|FileSystemRights.ChangePermissions|FileSystemRights.TakeOwnership))!=0)throw new InvalidDataException();
        }
    }
    static int Broker(int parentId){
        Basic basic=new Basic();int returned;if(NtQueryInformationProcess(Process.GetCurrentProcess().Handle,0,ref basic,Marshal.SizeOf(basic),out returned)!=0||basic.Parent.ToInt64()!=parentId)return 2;
        PrivateBinary();var request=Request(Line(new StreamReader(Console.OpenStandardInput(),Encoding.UTF8,false,1024,true)));
        request.Add("callerSid",WindowsIdentity.GetCurrent().User.Value);
        using(var parent=Process.GetProcessById(parentId))using(var binary=new FileStream(Self(),FileMode.Open,FileAccess.Read,FileShare.Read)){
            string nonce=Guid.NewGuid().ToString("N");var security=new PipeSecurity();security.SetAccessRuleProtection(true,false);
            security.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User,PipeAccessRights.FullControl,AccessControlType.Allow));security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid,null),PipeAccessRights.ReadWrite,AccessControlType.Allow));security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid,null),PipeAccessRights.FullControl,AccessControlType.Deny));
            using(var pipe=new NamedPipeServerStream("RovarinStartup-"+nonce,PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous,8192,8192,security))
            using(var guard=new Timer(delegate{try{if(parent.HasExited)Environment.Exit(3);}catch{Environment.Exit(3);}},null,200,200))
            using(var deadline=new Timer(delegate{Environment.Exit(3);},null,130000,Timeout.Infinite)){
                Process elevated;
                try{elevated=Process.Start(new ProcessStartInfo {FileName=Self(),Arguments="--worker "+nonce+" "+Process.GetCurrentProcess().Id,UseShellExecute=true,Verb="runas",WorkingDirectory=Environment.SystemDirectory});}
                catch(Win32Exception e){Emit(new{success=false,code=e.NativeErrorCode==1223?"cancelled":"operation-failed"});return 0;}
                using(elevated){
                    var connected=pipe.BeginWaitForConnection(null,null);if(!connected.AsyncWaitHandle.WaitOne(20000))throw new IOException();pipe.EndWaitForConnection(connected);uint client;
                    if(!GetNamedPipeClientProcessId(pipe.SafePipeHandle,out client)||client!=(uint)elevated.Id)throw new InvalidDataException();
                    using(var writer=new StreamWriter(pipe,new UTF8Encoding(false),1024,true){AutoFlush=true})using(var reader=new StreamReader(pipe,Encoding.UTF8,false,1024,true)){
                        Emit(new{type="approval-ready"});
                        // Backend revalidates the live session after UAC, before
                        // sending GO. Revocation/cancel never authorizes a write.
                        if(Line(new StreamReader(Console.OpenStandardInput(),Encoding.UTF8,false,1024,true))!="GO"){writer.WriteLine("{}");if(!elevated.WaitForExit(5000))throw new IOException();return 1;}
                        writer.WriteLine(Json.Serialize(request));string line=Line(reader);var result=Json.Deserialize<Dictionary<string,object>>(line);Emit(result);
                    }
                    if(!elevated.WaitForExit(5000))throw new IOException();return elevated.ExitCode;
                }
            }
        }
    }
    static int Worker(string nonce,int brokerId){
        if(!Admin())return 2;
        using(var broker=Process.GetProcessById(brokerId)){
            if(!String.Equals(broker.MainModule.FileName,Self(),StringComparison.OrdinalIgnoreCase))return 2;
            using(var pipe=new NamedPipeClientStream(".","RovarinStartup-"+nonce,PipeDirection.InOut,PipeOptions.Asynchronous,TokenImpersonationLevel.Identification)){
                pipe.Connect(20000);uint server;if(!GetNamedPipeServerProcessId(pipe.SafePipeHandle,out server)||server!=(uint)broker.Id)return 2;
                using(var deadline=new Timer(delegate{Environment.Exit(3);},null,30000,Timeout.Infinite))using(var writer=new StreamWriter(pipe,new UTF8Encoding(false),1024,true){AutoFlush=true})using(var reader=new StreamReader(pipe,Encoding.UTF8,false,1024,true)){
                    var request=Request(Line(reader),true);if(broker.HasExited)return 2;
                    object result;try{result=Apply(request);}catch(UnauthorizedAccessException){result=new{success=false,code="access-denied"};}catch{result=new{success=false,code="unsupported"};}
                    writer.WriteLine(Json.Serialize(result));return 0;
                }
            }
        }
    }
    [STAThread]static int Main(string[] args){
        try{int pid;Guid nonce;if(args.Length==1&&Int32.TryParse(args[0],out pid)&&pid>0)return Broker(pid);if(args.Length==3&&args[0]=="--worker"&&Guid.TryParseExact(args[1],"N",out nonce)&&Int32.TryParse(args[2],out pid)&&pid>0)return Worker(args[1],pid);return 2;}
        catch{Emit(new{success=false,code="operation-failed"});return 1;}
    }
}
