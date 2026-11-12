using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

// Unelevated per-user public network owner. No WebView, shell, arbitrary action,
// persisted browser bearer, telemetry collector, or privileged service.
internal static class StandbySupervisor {
 static JavaScriptSerializer Json{get{return new JavaScriptSerializer(){MaxJsonLength=131072};}}
 static readonly SemaphoreSlim Gate=new SemaphoreSlim(1,1);
 static readonly object StateLock=new object();
 static readonly Dictionary<string,Dictionary<string,object>> Sessions=new Dictionary<string,Dictionary<string,object>>();
 static Dictionary<string,object> manifest,state;
 static string root,node,config,data,localPipe,backendPipe,secret,configHash;
 static int port,timeout;static bool quit;static TcpListener listener;static Process child;
 static long lastLaunch;static int launches;static string lastError="";
 static volatile bool retiring;
 static bool stopping;
 static bool controlledStop;
 static readonly byte[] HeaderEnd={13,10,13,10};
 [StructLayout(LayoutKind.Sequential)] struct Luid {public uint low;public int high;}
 [StructLayout(LayoutKind.Sequential)] struct TokenStatistics {public Luid token,authentication;public long expires;public int type,impersonation;public uint charged,available,groups,privileges;public Luid modified;}
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,out TokenStatistics value,int size,out int needed);
 static string Logon(){TokenStatistics value;int needed;using(var identity=WindowsIdentity.GetCurrent()){if(!GetTokenInformation(identity.Token,10,out value,Marshal.SizeOf(typeof(TokenStatistics)),out needed))throw new IOException("Logon identity unavailable");}return value.authentication.high.ToString("x8")+value.authentication.low.ToString("x8");}
 static object Com(object value,string member,BindingFlags flags,params object[] args){return value.GetType().InvokeMember(member,flags,null,value,args);}
 static object Prop(object value,string member){return Com(value,member,BindingFlags.GetProperty);}
 static string AccountSid(object value){var name=Convert.ToString(value);return name.StartsWith("S-1-",StringComparison.Ordinal)?new SecurityIdentifier(name).Value:((SecurityIdentifier)new NTAccount(name).Translate(typeof(SecurityIdentifier))).Value;}
 static bool TaskSessionAllowed(){
  object service=null,folder=null,task=null;
  try{
   service=Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service"));Com(service,"Connect",BindingFlags.InvokeMethod);folder=Com(service,"GetFolder",BindingFlags.InvokeMethod,"\\");
   try{task=Com(folder,"GetTask",BindingFlags.InvokeMethod,"Rovarin Smart Standby "+Hash(Encoding.UTF8.GetBytes(root.ToLowerInvariant()+WindowsIdentity.GetCurrent().User.Value)).Substring(0,16).ToUpperInvariant());}
   catch(TargetInvocationException error){if(Marshal.GetHRForException(error.InnerException)==unchecked((int)0x80070002))return true;throw;}
   var definition=Prop(task,"Definition");var actions=Prop(definition,"Actions");var action=Com(actions,"Item",BindingFlags.GetProperty,1);var principal=Prop(definition,"Principal");
   if(Convert.ToInt32(Prop(actions,"Count"))!=1||!TextPath(Convert.ToString(Prop(action,"Path"))).Equals(TextPath(Process.GetCurrentProcess().MainModule.FileName),StringComparison.OrdinalIgnoreCase)||Convert.ToString(Prop(action,"Arguments"))!="run"||AccountSid(Prop(principal,"UserId"))!=WindowsIdentity.GetCurrent().User.Value||Convert.ToInt32(Prop(principal,"RunLevel"))!=0||Convert.ToInt32(Prop(principal,"LogonType"))!=3)throw new IOException("Startup task identity unavailable");
   if(Convert.ToString(Prop(definition,"Data"))=="RovarinLogon:"+Logon())return true;
   var triggers=Prop(definition,"Triggers");for(int i=1;i<=Convert.ToInt32(Prop(triggers,"Count"));i++){var trigger=Com(triggers,"Item",BindingFlags.GetProperty,i);if(Convert.ToInt32(Prop(trigger,"Type"))==9&&Convert.ToBoolean(Prop(trigger,"Enabled"))&&AccountSid(Prop(trigger,"UserId"))==WindowsIdentity.GetCurrent().User.Value)return true;}
   // A previous session's recovery schedule never opts a user into sign-in startup.
   Com(task,"Enabled",BindingFlags.SetProperty,false);return false;
  }finally{foreach(var value in new[]{task,folder,service})if(value!=null&&Marshal.IsComObject(value))Marshal.ReleaseComObject(value);}
 }
 static string TextPath(string value){return Path.GetFullPath(value);}
 [StructLayout(LayoutKind.Sequential)] struct FileInfoNative { public uint attrs,createdLow,createdHigh,accessLow,accessHigh,writeLow,writeHigh,volume,sizeHigh,sizeLow,links,indexHigh,indexLow; }
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr file,out FileInfoNative info);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandle(IntPtr file,StringBuilder path,uint size,uint flags);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetNamedPipeServerProcessId(IntPtr pipe,out uint pid);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool WaitNamedPipe(string name,uint timeout);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
 static void NoInherit(IntPtr handle){if(!SetHandleInformation(handle,1,0))throw new IOException("Runtime handle isolation failed");}
 static string Text(Dictionary<string,object> d,string k){object v;return d.TryGetValue(k,out v)?Convert.ToString(v):"";}
 static long Number(Dictionary<string,object> d,string k){object v;return d.TryGetValue(k,out v)?Convert.ToInt64(v):0;}
 static bool Flag(Dictionary<string,object> d,string k){object v;return d.TryGetValue(k,out v)&&v is bool&&(bool)v;}
 static long Now(){return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();}
 static string Hash(byte[] bytes){using(var h=SHA256.Create())return BitConverter.ToString(h.ComputeHash(bytes)).Replace("-","").ToLowerInvariant();}
 static byte[] ReadFile(string path,bool privateFile=false){
  SafePath(path);using(var file=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read|FileShare.Delete)){
   FileInfoNative info;var final=new StringBuilder(32768);
   if(!GetFileInformationByHandle(file.SafeFileHandle.DangerousGetHandle(),out info)||(info.attrs&(uint)FileAttributes.ReparsePoint)!=0||privateFile&&info.links!=1||GetFinalPathNameByHandle(file.SafeFileHandle.DangerousGetHandle(),final,(uint)final.Capacity,0)==0)throw new IOException("Unverified file identity");
   var resolved=final.ToString();if(resolved.StartsWith("\\\\?\\"))resolved=resolved.Substring(4);if(!Path.GetFullPath(path).Equals(resolved,StringComparison.OrdinalIgnoreCase))throw new IOException("Redirected file identity");
   if(privateFile&&file.Length>131072)throw new IOException("Private file size");using(var bytes=new MemoryStream()){file.CopyTo(bytes);return bytes.ToArray();}
  }
 }
 static string FileHash(string path){
  if(path==config)return Hash(ReadFile(path,true));
  SafePath(path);using(var file=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read|FileShare.Delete))using(var hash=SHA256.Create()){
   FileInfoNative info;var final=new StringBuilder(32768);
   if(!GetFileInformationByHandle(file.SafeFileHandle.DangerousGetHandle(),out info)||(info.attrs&(uint)FileAttributes.ReparsePoint)!=0||GetFinalPathNameByHandle(file.SafeFileHandle.DangerousGetHandle(),final,(uint)final.Capacity,0)==0)throw new IOException("Unverified runtime file");
   var resolved=final.ToString();if(resolved.StartsWith("\\\\?\\"))resolved=resolved.Substring(4);if(!Path.GetFullPath(path).Equals(resolved,StringComparison.OrdinalIgnoreCase))throw new IOException("Redirected runtime file");
   return BitConverter.ToString(hash.ComputeHash(file)).Replace("-","").ToLowerInvariant();
  }
 }
 static string Resolve(string value){return Path.GetFullPath(Path.IsPathRooted(value)?value:Path.Combine(AppDomain.CurrentDomain.BaseDirectory,value));}
 static void SafePath(string path){
  for(string p=Path.GetFullPath(path);p!=Path.GetPathRoot(p);p=Path.GetDirectoryName(p))if(File.Exists(p)||Directory.Exists(p))if((File.GetAttributes(p)&FileAttributes.ReparsePoint)!=0)throw new IOException("Redirected runtime path");
 }
 static FileSecurity PrivateAcl(){var a=new FileSecurity();a.SetAccessRuleProtection(true,false);var sid=WindowsIdentity.GetCurrent().User;a.SetOwner(sid);a.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,AccessControlType.Allow));a.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid,null),FileSystemRights.FullControl,AccessControlType.Allow));return a;}
 static void LoadManifest(){
  var file=Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"standby-runtime.json");SafePath(file);
  manifest=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(file));
  if(Number(manifest,"schema")!=1)throw new IOException("Unsupported runtime");
  root=Resolve(Text(manifest,"root"));node=Resolve(Text(manifest,"node"));config=Resolve(Text(manifest,"config"));data=Path.GetDirectoryName(config);
  port=(int)Number(manifest,"port");if(port<1||port>65535)throw new IOException("Invalid port");
  SafePath(config);SafePath(node);if(FileHash(node)!=Text(manifest,"nodeHash"))throw new IOException("Runtime integrity");
  localPipe="Rovarin.supervisor."+Hash(Encoding.UTF8.GetBytes(root.ToLowerInvariant()+WindowsIdentity.GetCurrent().User.Value)).Substring(0,32);
  timeout=(int)Number(manifest,"timeoutMs");if(timeout<20000||timeout>60000)throw new IOException("Invalid idle timeout");
  VerifyFiles();
 }
 static void VerifyFiles(){
  var files=(Dictionary<string,object>)manifest["files"];
  foreach(var item in files){var full=Path.GetFullPath(Path.Combine(root,item.Key));if(!full.StartsWith(root+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase)||FileHash(full)!=(string)item.Value)throw new IOException("Application integrity");}
 }
 static string StateFile{get{return Path.Combine(data,"standby-state.bin");}}
 static byte[] Entropy{get{return Encoding.UTF8.GetBytes("Rovarin.Standby.v1");}}
 static void SaveState(){lock(StateLock){
  var bytes=Encoding.UTF8.GetBytes(Json.Serialize(state));var blob=ProtectedData.Protect(bytes,Entropy,DataProtectionScope.CurrentUser);Array.Clear(bytes,0,bytes.Length);
  var temp=Path.Combine(data,"standby-write-"+Guid.NewGuid().ToString("N"));
  try{using(var f=new FileStream(temp,FileMode.CreateNew,FileSystemRights.Write,FileShare.None,4096,FileOptions.WriteThrough,PrivateAcl())){f.Write(blob,0,blob.Length);f.Flush(true);}if(File.Exists(StateFile)){SafePath(StateFile);File.Replace(temp,StateFile,null);}else File.Move(temp,StateFile);}finally{if(File.Exists(temp))File.Delete(temp);}
 }}
 static void LoadState(){
  if(File.Exists(StateFile)){
   SafePath(StateFile);if(new FileInfo(StateFile).Length>131072)throw new IOException("Invalid state");
   var acl=File.GetAccessControl(StateFile);var sid=WindowsIdentity.GetCurrent().User;
   if(!acl.GetOwner(typeof(SecurityIdentifier)).Equals(sid)||!acl.AreAccessRulesProtected)throw new IOException("Unsafe state owner");
   foreach(FileSystemAccessRule rule in acl.GetAccessRules(true,true,typeof(SecurityIdentifier)))if(rule.AccessControlType==AccessControlType.Allow&&!rule.IdentityReference.Equals(sid)&&!rule.IdentityReference.Equals(new SecurityIdentifier(WellKnownSidType.LocalSystemSid,null)))throw new IOException("Unsafe state access");
   var clear=ProtectedData.Unprotect(ReadFile(StateFile,true),Entropy,DataProtectionScope.CurrentUser);try{state=Json.Deserialize<Dictionary<string,object>>(Encoding.UTF8.GetString(clear));}finally{Array.Clear(clear,0,clear.Length);}
  }else{
   var key=new byte[32];using(var rng=RandomNumberGenerator.Create())rng.GetBytes(key);
   state=new Dictionary<string,object>{{"secret",Convert.ToBase64String(key)},{"pipe","Rovarin.backend."+Guid.NewGuid().ToString("N")},{"failures",new Dictionary<string,object>()}};Array.Clear(key,0,key.Length);SaveState();
  }
  secret=Text(state,"secret");backendPipe=Text(state,"pipe");
  if(Text(state,"sourceFingerprint")!=Text(manifest,"fingerprint")){state["sourceFingerprint"]=Text(manifest,"fingerprint");state["retireUntil"]=0L;SaveState();}
  if(Convert.FromBase64String(secret).Length!=32||!System.Text.RegularExpressions.Regex.IsMatch(backendPipe,@"^Rovarin\.backend\.[a-f0-9]{32}$"))throw new IOException("Invalid private transport");
 }
 static byte[] Prefix(byte channel,string ip){var a=Encoding.UTF8.GetBytes(ip);var b=new byte[34+a.Length];Buffer.BlockCopy(Convert.FromBase64String(secret),0,b,0,32);b[32]=channel;b[33]=(byte)a.Length;Buffer.BlockCopy(a,0,b,34,a.Length);return b;}
 static async Task<Dictionary<string,object>> Control(string action,Dictionary<string,object> request=null){
  using(var pipe=new NamedPipeClientStream(".",backendPipe,PipeDirection.InOut,PipeOptions.Asynchronous)){
   await pipe.ConnectAsync(1000);NoInherit(pipe.SafePipeHandle.DangerousGetHandle());var prefix=Prefix(1,"127.0.0.1");await pipe.WriteAsync(prefix,0,prefix.Length);
   request=request??new Dictionary<string,object>();request["action"]=action;var bytes=Encoding.UTF8.GetBytes(Json.Serialize(request)+"\n");await pipe.WriteAsync(bytes,0,bytes.Length);
   var read=new StreamReader(pipe,Encoding.UTF8,false,4096,true);var task=read.ReadLineAsync();if(await Task.WhenAny(task,Task.Delay(2000))!=task)throw new IOException("Private status timeout");
   var line=await task;if(line==null||line.Length>65536)throw new IOException("Invalid private status");var result=Json.Deserialize<Dictionary<string,object>>(line);if(result.ContainsKey("error"))throw new IOException("Private status unavailable");return result;
  }
 }
 static async Task<bool> BackendReady(){try{if(!WaitNamedPipe("\\\\.\\pipe\\"+backendPipe,1)&&Marshal.GetLastWin32Error()==2)return false;var s=await Control("status");return Number(s,"pid")>0&&Text(s,"sourceFingerprint")==Text(manifest,"fingerprint");}catch{return false;}}
 static bool Enabled(){try{var c=Json.Deserialize<Dictionary<string,object>>(Encoding.UTF8.GetString(ReadFile(config,true)));return !c.ContainsKey("smartStandby")||Flag(c,"smartStandby");}catch{return true;}}
 static async Task Wake(){
  if(retiring||Number(state,"retireUntil")>Now())throw new IOException("Installation handoff in progress");
  if(await BackendReady())return;
  Sessions.Clear();configHash=null;controlledStop=false;VerifyFiles();
  if(child!=null&&!child.HasExited)throw new IOException("Backend is recovering");
  if(Now()-lastLaunch<60000){if(launches>=3)throw new IOException("Startup retry cooling down");launches++;}else{lastLaunch=Now();launches=1;}
  var p=new ProcessStartInfo(node,"\""+Path.Combine(root,"server.js")+"\""){WorkingDirectory=root,UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true};
  foreach(var key in new[]{"NODE_OPTIONS","NODE_PATH","PC_MONITOR_PIN","ROVARIN_STANDBY_PIPE","ROVARIN_STANDBY_SECRET"})p.EnvironmentVariables.Remove(key);
  p.EnvironmentVariables["PORT"]=port.ToString();p.EnvironmentVariables["ROVARIN_STANDBY_PREFERRED_PORT"]=Number(manifest,"port").ToString();p.EnvironmentVariables["ROVARIN_STANDBY_PIPE"]=backendPipe;p.EnvironmentVariables["ROVARIN_STANDBY_SECRET"]=secret;p.EnvironmentVariables["ROVARIN_STANDBY_IDLE_MS"]=timeout.ToString();
  if(child!=null)child.Dispose();child=Process.Start(p);child.OutputDataReceived+=(s,e)=>{
   if(e.Data==null||!e.Data.StartsWith("ROVARIN-STANDBY-RETIRE "))return;
   string expected;using(var h=new HMACSHA256(Convert.FromBase64String(secret)))expected=BitConverter.ToString(h.ComputeHash(Encoding.UTF8.GetBytes("retire:"+Text(manifest,"fingerprint")))).Replace("-","").ToLowerInvariant();
   if(e.Data=="ROVARIN-STANDBY-RETIRE "+expected){retiring=true;lock(StateLock){state["retireUntil"]=Now()+120000;SaveState();}}
  };child.ErrorDataReceived+=(s,e)=>{};child.BeginOutputReadLine();child.BeginErrorReadLine();
  for(int i=0;i<50;i++){if(await BackendReady())return;if(child.HasExited)throw new IOException("Backend startup failed");await Task.Delay(150);}
  throw new IOException("Backend startup timed out");
 }
 static bool Allowed(IPAddress address){if(address.IsIPv4MappedToIPv6)address=address.MapToIPv4();if(address.Equals(IPAddress.Loopback)||address.Equals(IPAddress.IPv6Loopback))return true;var b=address.GetAddressBytes();if(b.Length==4)return b[0]==100&&b[1]>=64&&b[1]<=127;if(b.Length==16)return b[0]==0xfd&&b[1]==0x7a&&b[2]==0x11&&b[3]==0x5c&&b[4]==0xa1&&b[5]==0xe0;return false;}
 sealed class Request {
  public string Method,Target,Host,Origin,Cookie,ContentType,NativeProof;public byte[] Header,Body;
 }
 static async Task<Request> ReadRequest(NetworkStream stream){
  var memory=new MemoryStream();int matched=0;var one=new byte[1];
  while(memory.Length<16384){if(await stream.ReadAsync(one,0,1)==0)throw new IOException("Incomplete header");memory.WriteByte(one[0]);matched=one[0]==HeaderEnd[matched]?matched+1:(one[0]==13?1:0);if(matched==4)break;}
  if(matched!=4)throw new IOException("Header limit");
  var header=memory.ToArray();var lines=Encoding.ASCII.GetString(header).Split(new[]{"\r\n"},StringSplitOptions.None);var first=lines[0].Split(' ');if(first.Length!=3||!first[1].StartsWith("/")||first[1].StartsWith("//")||first[2]!="HTTP/1.1")throw new IOException("Invalid request");
  var headers=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
  for(int i=1;i<lines.Length&&lines[i]!="";i++){int colon=lines[i].IndexOf(':');if(colon<1||Char.IsWhiteSpace(lines[i][0]))throw new IOException("Invalid header");var key=lines[i].Substring(0,colon);if(headers.ContainsKey(key))throw new IOException("Duplicate header");headers.Add(key,lines[i].Substring(colon+1).Trim());}
  var r=new Request{Method=first[0],Target=first[1],Header=header,Body=new byte[0],Host=headers.ContainsKey("Host")?headers["Host"]:"",Origin=headers.ContainsKey("Origin")?headers["Origin"]:null,Cookie=headers.ContainsKey("Cookie")?headers["Cookie"]:"",ContentType=headers.ContainsKey("Content-Type")?headers["Content-Type"]:""};
  if(r.Host.Length==0||r.Host.Contains("/")||r.Host.Contains("\\"))throw new IOException("Invalid host");
  r.NativeProof=headers.ContainsKey("X-PC-Monitor-Desktop")?headers["X-PC-Monitor-Desktop"]:"";
  if(r.Method=="POST"&&r.Target=="/api/login"){
   int length;if(headers.ContainsKey("Transfer-Encoding")||!headers.ContainsKey("Content-Length")||!Int32.TryParse(headers["Content-Length"],out length)||length<1||length>512)throw new IOException("Invalid login body");
   r.Body=new byte[length];int offset=0;while(offset<length){var n=await stream.ReadAsync(r.Body,offset,length-offset);if(n==0)throw new IOException("Incomplete body");offset+=n;}
  }
  return r;
 }
 static async Task Reply(Stream s,int code,string type,byte[] body){var h=Encoding.ASCII.GetBytes("HTTP/1.1 "+code+" "+(code==200?"OK":"Unavailable")+"\r\nConnection: close\r\nCache-Control: no-store\r\n"+(code==429?"Retry-After: 60\r\n":"")+"X-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nX-Frame-Options: DENY\r\nContent-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'\r\nContent-Type: "+type+"\r\nContent-Length: "+body.Length+"\r\n\r\n");await s.WriteAsync(h,0,h.Length);await s.WriteAsync(body,0,body.Length);}
 static Task JsonReply(Stream s,int code,string error){return Reply(s,code,"application/json",Encoding.UTF8.GetBytes(Json.Serialize(new{success=false,error=error})));}
 static bool SameOrigin(Request r){if(r.Origin==null)return true;Uri origin,host;return Uri.TryCreate(r.Origin,UriKind.Absolute,out origin)&&Uri.TryCreate("http://"+r.Host,UriKind.Absolute,out host)&&origin.Scheme=="http"&&origin.Authority.Equals(host.Authority,StringComparison.OrdinalIgnoreCase)&&origin.AbsolutePath=="/";}
 static bool Locked(string ip){lock(StateLock){var failures=(Dictionary<string,object>)state["failures"];object value;if(!failures.TryGetValue(ip,out value))return false;return Number((Dictionary<string,object>)value,"until")>Now();}}
 static void RefreshRateEpoch(){
  var c=Json.Deserialize<Dictionary<string,object>>(Encoding.UTF8.GetString(ReadFile(config,true)));object credential;
  if(!c.TryGetValue("pinCredential",out credential))credential=Text(c,"pin");
  var revision=Hash(Encoding.UTF8.GetBytes(Json.Serialize(new object[]{Text(c,"pinVersion"),credential})));
  lock(StateLock){if(Text(state,"credentialRevision")==revision)return;}
  var value=credential as Dictionary<string,object>;
  if(value!=null){
   if(value.Count!=5||Text(value,"scheme")!="scrypt-dpapi-v1"||!System.Text.RegularExpressions.Regex.IsMatch(Text(value,"salt"),"^[a-f0-9]{32}$")||!System.Text.RegularExpressions.Regex.IsMatch(Text(value,"hash"),"^[a-f0-9]{64}$"))throw new IOException("Credential unavailable");
   var clear=ProtectedData.Unprotect(Convert.FromBase64String(Text(value,"protected")),Encoding.UTF8.GetBytes("Rovarin.Pin.v1"),DataProtectionScope.CurrentUser);
   try{if(clear.Length!=Number(value,"length")||!System.Text.RegularExpressions.Regex.IsMatch(Encoding.UTF8.GetString(clear),"^(?:[0-9]{6}|[0-9]{8}|[0-9]{12})$"))throw new IOException("Credential unavailable");}finally{Array.Clear(clear,0,clear.Length);}
  }else if(!System.Text.RegularExpressions.Regex.IsMatch(Convert.ToString(credential),"^(?:[0-9]{6}|[0-9]{8}|[0-9]{12})$"))throw new IOException("Credential unavailable");
  lock(StateLock){state["credentialRevision"]=revision;state["failures"]=new Dictionary<string,object>();SaveState();}
 }
 static void Failure(string ip,bool success){lock(StateLock){
  var failures=(Dictionary<string,object>)state["failures"];if(success){failures.Remove(ip);SaveState();return;}
  var expired=new List<string>();foreach(var entry in failures)if(Now()-Number((Dictionary<string,object>)entry.Value,"at")>600000)expired.Add(entry.Key);foreach(var key in expired)failures.Remove(key);
  if(!failures.ContainsKey(ip)){if(failures.Count>=128)throw new IOException("Rate capacity");failures[ip]=new Dictionary<string,object>{{"count",0},{"until",0L},{"at",Now()}};}
  var value=(Dictionary<string,object>)failures[ip];long count=Number(value,"count")+1;value["count"]=count;value["at"]=Now();if(count>=5){value["until"]=Now()+60000;value["count"]=0;}SaveState();
 }}
 static bool VerifyPin(byte[] body){
  var request=Json.Deserialize<Dictionary<string,object>>(Encoding.UTF8.GetString(body));if(request.Count!=1||!request.ContainsKey("pin")||!(request["pin"] is string))return false;
  var pin=(string)request["pin"];if(!System.Text.RegularExpressions.Regex.IsMatch(pin,@"^(?:\d{6}|\d{8}|\d{12})$"))return false;
  var c=Json.Deserialize<Dictionary<string,object>>(Encoding.UTF8.GetString(ReadFile(config,true)));object value;
  if(!c.TryGetValue("pinCredential",out value)){
   var legacy=Text(c,"pin");if(!System.Text.RegularExpressions.Regex.IsMatch(legacy,@"^(?:\d{6}|\d{8}|\d{12})$"))throw new IOException("Credential unavailable");
   int difference=pin.Length^legacy.Length;for(int i=0;i<Math.Max(pin.Length,legacy.Length);i++)difference|=(i<pin.Length?pin[i]:0)^(i<legacy.Length?legacy[i]:0);return difference==0;
  }var credential=value as Dictionary<string,object>;
  if(credential==null||credential.Count!=5||Text(credential,"scheme")!="scrypt-dpapi-v1")throw new IOException("Credential unavailable");
  var clear=ProtectedData.Unprotect(Convert.FromBase64String(Text(credential,"protected")),Encoding.UTF8.GetBytes("Rovarin.Pin.v1"),DataProtectionScope.CurrentUser);
  try{var supplied=Encoding.UTF8.GetBytes(pin);int mismatch=supplied.Length^clear.Length;for(int i=0;i<Math.Max(clear.Length,supplied.Length);i++)mismatch|=(i<clear.Length?clear[i]:0)^(i<supplied.Length?supplied[i]:0);Array.Clear(supplied,0,supplied.Length);return mismatch==0;}finally{Array.Clear(clear,0,clear.Length);}
 }
 static string CookieToken(Request r){foreach(var part in r.Cookie.Split(';')){var p=part.Trim();if(p.StartsWith("pc_monitor_session=",StringComparison.Ordinal))return p.Substring(19);}return "";}
 static bool NativeWake(Request r,string ip){
  if((ip!="127.0.0.1"&&ip!="::1")||!r.Target.StartsWith("/api/desktop/",StringComparison.Ordinal)||r.NativeProof.Length!=44)return false;
  try{
   var clear=ProtectedData.Unprotect(ReadFile(Path.Combine(data,"desktop-trust.bin"),true),Encoding.UTF8.GetBytes("PCMonitor.NativeDesktop.v1"),DataProtectionScope.CurrentUser);
   try{var supplied=Convert.FromBase64String(r.NativeProof);int difference=clear.Length^supplied.Length;for(int i=0;i<Math.Max(clear.Length,supplied.Length);i++)difference|=(i<clear.Length?clear[i]:0)^(i<supplied.Length?supplied[i]:0);Array.Clear(supplied,0,supplied.Length);return clear.Length==32&&difference==0;}finally{Array.Clear(clear,0,clear.Length);}
  }catch{return false;}
 }
 static async Task Serve(TcpClient client){
  using(client){NoInherit(client.Client.Handle);client.NoDelay=true;var network=client.GetStream();
   try{
    var address=((IPEndPoint)client.Client.RemoteEndPoint).Address;if(!Allowed(address)){await JsonReply(network,403,"Access denied.");return;}
    var ip=address.IsIPv4MappedToIPv6?address.MapToIPv4().ToString():address.ToString();var reading=ReadRequest(network);if(await Task.WhenAny(reading,Task.Delay(10000))!=reading)throw new IOException("Header timeout");var request=await reading;
    if(request.Method!="GET"&&request.Method!="HEAD"&&!SameOrigin(request)){await JsonReply(network,403,"Origin denied.");return;}
    await Gate.WaitAsync();bool locked=true;
    try{
     bool ready=await BackendReady();
     if(!ready&&child!=null&&child.HasExited){if(!controlledStop){Sessions.Clear();configHash=null;}child.Dispose();child=null;}
     if(request.Method=="POST"&&request.Target=="/api/login"){
      if(!System.Text.RegularExpressions.Regex.IsMatch(request.ContentType,@"^application/json(?:\s*;|$)",System.Text.RegularExpressions.RegexOptions.IgnoreCase)){await JsonReply(network,415,"JSON login required.");return;}
      bool invalid=false;try{var login=Json.Deserialize<Dictionary<string,object>>(Encoding.UTF8.GetString(request.Body));if(login==null||login.Count!=1||!login.ContainsKey("pin")||!(login["pin"] is string))invalid=true;}catch{invalid=true;}
      if(invalid){await JsonReply(network,400,"Invalid login request.");return;}
      if(!SameOrigin(request)){await JsonReply(network,403,"Origin denied.");return;}
      RefreshRateEpoch();
      if(Locked(ip)){await JsonReply(network,429,"Too many attempts. Try again shortly.");return;}
      if(!VerifyPin(request.Body)){Failure(ip,false);await JsonReply(network,Locked(ip)?429:401,"Incorrect PIN.");return;}
      Failure(ip,true);
     }
     if(!ready){
      var token=CookieToken(request);Dictionary<string,object> session=null;
      if(token.Length==43&&configHash!=null&&FileHash(config)==configHash)Sessions.TryGetValue(Hash(Encoding.UTF8.GetBytes(token)),out session);
      bool cookie=session!=null&&Number(session,"expiresAt")>Now();
      if(cookie){
       // Consume once. Revocation in the new backend can never be resurrected.
       Sessions.Remove(Hash(Encoding.UTF8.GetBytes(token)));var savedHash=configHash;
       var remaining=new Dictionary<string,Dictionary<string,object>>(Sessions);await Wake();foreach(var item in remaining)Sessions[item.Key]=item.Value;configHash=savedHash;
       var restore=new Dictionary<string,object>(session);restore["token"]=token;restore["configHash"]=savedHash;
       if(!Flag(await Control("restore",restore),"success")){await JsonReply(network,401,"Authentication required.");return;}
       ready=true;
      }else if(NativeWake(request,ip)){
       await Wake();ready=true;
      }else if(request.Method=="POST"&&request.Target=="/api/login"){
       await Wake();ready=true;
      }
      if(!ready){await Sleeping(network,request);return;}
     }else{
      var token=CookieToken(request);Dictionary<string,object> session;
      if(token.Length==43&&configHash!=null&&FileHash(config)==configHash&&Sessions.TryGetValue(Hash(Encoding.UTF8.GetBytes(token)),out session)){
       Sessions.Remove(Hash(Encoding.UTF8.GetBytes(token)));var restore=new Dictionary<string,object>(session);restore["token"]=token;restore["configHash"]=configHash;await Control("restore",restore);
      }
     }
     var pipe=new NamedPipeClientStream(".",backendPipe,PipeDirection.InOut,PipeOptions.Asynchronous);try{
      await pipe.ConnectAsync(1000);NoInherit(pipe.SafePipeHandle.DangerousGetHandle());var prefix=Prefix(0,ip);await pipe.WriteAsync(prefix,0,prefix.Length);await pipe.WriteAsync(request.Header,0,request.Header.Length);if(request.Body.Length>0)await pipe.WriteAsync(request.Body,0,request.Body.Length);
      Gate.Release();locked=false;
      var up=network.CopyToAsync(pipe);var down=pipe.CopyToAsync(network);await Task.WhenAny(up,down);
     }finally{pipe.Dispose();}
    }finally{if(locked)Gate.Release();}
   }catch{try{JsonReply(network,503,"Rovarin is waking or recovering. Try again shortly; your PIN has not changed.").GetAwaiter().GetResult();}catch{}}
  }
 }
 static async Task Sleeping(Stream stream,Request r){
  var target=r.Target.Split('?')[0];if(r.Method!="GET"&&r.Method!="HEAD"){await JsonReply(stream,401,"Authentication required.");return;}
  if(target.StartsWith("/api/")){await JsonReply(stream,401,"Authentication required.");return;}
  string asset=target=="/"||target=="/index.html"?"login.html":target.TrimStart('/');
  var allowed=new HashSet<string>{"login.html","login.js","app.css","liquid-glass.css","liquid-bootstrap.js","liquid-glass.js","liquid-shaders.js","pin-lifecycle.js","pin-lifecycle.css","rovarin-icon.png","rovarin-touch.png"};
  if(!allowed.Contains(asset)){await JsonReply(stream,404,"Not found.");return;}
  var file=Path.Combine(root,"public",asset);SafePath(file);var bytes=File.ReadAllBytes(file);
  if(asset=="login.html"){
   int length=12;try{var c=Json.Deserialize<Dictionary<string,object>>(Encoding.UTF8.GetString(ReadFile(config,true)));length=c.ContainsKey("pinCredential")?(int)Number((Dictionary<string,object>)c["pinCredential"],"length"):Text(c,"pin").Length;if(length!=6&&length!=8&&length!=12)length=12;}catch{}
   bytes=Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(bytes).Replace("</head>","<meta name=\"rovarin-pin-mode\" content=\""+length+"\"></head>"));
  }
  string type=asset.EndsWith(".css")?"text/css":asset.EndsWith(".js")?"text/javascript":asset.EndsWith(".png")?"image/png":"text/html; charset=utf-8";
  await Reply(stream,200,type,r.Method=="HEAD"?new byte[0]:bytes);
 }
 static async Task Monitor(){while(!quit){await Task.Delay(2000);await Gate.WaitAsync();try{
  if(await BackendReady()){
   if(!Enabled())continue;
   var result=await Control("drain");if(Flag(result,"draining")){
    controlledStop=true;
    var nextHash=Text(result,"configHash");
    if(configHash!=nextHash)Sessions.Clear();configHash=nextHash;
    var expired=new List<string>();foreach(var entry in Sessions)if(Number(entry.Value,"expiresAt")<=Now())expired.Add(entry.Key);foreach(var key in expired)Sessions.Remove(key);
    foreach(var item in (System.Collections.IEnumerable)result["sessions"]){var entry=(Dictionary<string,object>)item;Sessions[Text(entry,"hash")]=entry;}
    // Preserve still-unconsumed cookies belonging to other devices across wakes,
    // with the same bounded capacity as the backend. Never persist bearer tokens.
    while(Sessions.Count>64){string oldest=null;long expires=long.MaxValue;foreach(var entry in Sessions)if(Number(entry.Value,"expiresAt")<expires){oldest=entry.Key;expires=Number(entry.Value,"expiresAt");}Sessions.Remove(oldest);}
    for(int i=0;i<30&&await BackendReady();i++)await Task.Delay(100);
    if(child!=null&&child.HasExited){child.Dispose();child=null;}
   }
  }else if(retiring||stopping){quit=true;listener.Stop();}else if(!Enabled())await Wake();
 }catch(Exception e){lastError=e.GetType().Name;}finally{Gate.Release();}}}
 static async Task LocalCommands(){
  var sid=WindowsIdentity.GetCurrent().User;var acl=new PipeSecurity();acl.SetAccessRuleProtection(true,false);acl.AddAccessRule(new PipeAccessRule(sid,PipeAccessRights.FullControl,AccessControlType.Allow));
  while(!quit){using(var pipe=new NamedPipeServerStream(localPipe,PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous,4096,4096,acl)){
   NoInherit(pipe.SafePipeHandle.DangerousGetHandle());
   await pipe.WaitForConnectionAsync();try{
    var read=new StreamReader(pipe,Encoding.UTF8,false,1024,true);var task=read.ReadLineAsync();if(await Task.WhenAny(task,Task.Delay(2000))!=task)continue;string command=await task;
    await Gate.WaitAsync();Dictionary<string,object> result;
    try{
     if(command=="wake"){await Wake();result=new Dictionary<string,object>{{"ready",true},{"port",port},{"standby",Enabled()},{"standbyAvailable",true}};}
     else if(command=="stop"){
      if(await BackendReady()){var stopped=await Control("drain",new Dictionary<string,object>{{"retire",true}});if(Flag(stopped,"draining")){stopping=true;controlledStop=true;}result=new Dictionary<string,object>{{"ready",false},{"busy",true}};}
      else{quit=true;listener.Stop();result=new Dictionary<string,object>{{"ready",true}};}
     }else if(command=="status"){
      bool awake=await BackendReady();result=new Dictionary<string,object>{{"ready",true},{"port",port},{"standby",Enabled()},{"backendReady",awake},{"backendPid",awake?Number(await Control("status"),"pid"):0},{"error",lastError}};
     }
     else result=new Dictionary<string,object>{{"ready",false}};
    }finally{Gate.Release();}
    var bytes=Encoding.UTF8.GetBytes(Json.Serialize(result)+"\n");await pipe.WriteAsync(bytes,0,bytes.Length);
   }catch{try{var bytes=Encoding.UTF8.GetBytes("{\"ready\":false}\n");pipe.Write(bytes,0,bytes.Length);}catch{}}
  }}
 }
 static async Task Run(){
  int preferred=port;bool bound=false;
  for(int attempt=0;attempt<5&&preferred+attempt<=65535;attempt++){
   try{listener=new TcpListener(IPAddress.IPv6Any,preferred+attempt);listener.Server.DualMode=true;listener.ExclusiveAddressUse=true;listener.Start(32);NoInherit(listener.Server.Handle);port=preferred+attempt;bound=true;break;}
   catch(SocketException error){if(listener!=null)listener.Stop();if(error.SocketErrorCode!=SocketError.AddressAlreadyInUse)throw;}
  }
  if(!bound)throw new IOException("No approved port available");
  var monitor=Monitor();var local=LocalCommands();int clients=0;
  while(!quit){TcpClient client;try{var accepting=listener.AcceptTcpClientAsync();var completed=await Task.WhenAny(accepting,local,monitor);if(completed!=accepting){if(quit)break;throw new IOException("Native control loop stopped");}client=await accepting;}catch{if(quit)break;throw;}
   if(Interlocked.Increment(ref clients)>32){Interlocked.Decrement(ref clients);client.Close();continue;}
   var pending=Serve(client).ContinueWith(t=>Interlocked.Decrement(ref clients));
  }
 }
 [STAThread] public static int Main(string[] args){
  try{
   LoadManifest();
   if(args.Length==1&&args[0]=="session"){Console.WriteLine(Json.Serialize(new{ready=true,logon=Logon()}));return 0;}
   if(args.Length==1&&args[0]=="verify"){Console.WriteLine("{\"ready\":true,\"verified\":true}");return 0;}
   if(args.Length==1&&args[0]!="run"){
    if(args[0]!="wake"&&args[0]!="status"&&args[0]!="stop")return 2;
    using(var pipe=new NamedPipeClientStream(".",localPipe,PipeDirection.InOut)){
     pipe.Connect(2000);uint pid;IntPtr token=IntPtr.Zero;
     if(!GetNamedPipeServerProcessId(pipe.SafePipeHandle.DangerousGetHandle(),out pid))throw new IOException("Unknown supervisor");
     using(var process=Process.GetProcessById((int)pid)){
      if(!Path.GetFullPath(process.MainModule.FileName).Equals(Path.GetFullPath(Process.GetCurrentProcess().MainModule.FileName),StringComparison.OrdinalIgnoreCase)||!OpenProcessToken(process.Handle,8,out token))throw new IOException("Unknown supervisor");
      try{using(var identity=new WindowsIdentity(token))if(!identity.User.Equals(WindowsIdentity.GetCurrent().User))throw new IOException("Wrong supervisor owner");}finally{if(token!=IntPtr.Zero)CloseHandle(token);}
     }
     var bytes=Encoding.UTF8.GetBytes(args[0]+"\n");pipe.Write(bytes,0,bytes.Length);pipe.Flush();var read=new StreamReader(pipe).ReadLineAsync();if(!read.Wait(15000))throw new IOException("Supervisor timeout");var line=read.Result;Console.WriteLine(line);return line!=null&&Flag(Json.Deserialize<Dictionary<string,object>>(line),"ready")?0:1;
    }
   }
   if(args.Length>1)return 2;
   bool created;using(var mutex=new Mutex(true,"Local\\"+localPipe,out created)){if(!created)return 0;if(!TaskSessionAllowed())return 0;LoadState();Run().GetAwaiter().GetResult();mutex.ReleaseMutex();}
   return 0;
  }catch{Console.Error.WriteLine("Standby could not start safely. Existing installations and credentials were not changed.");return 1;}
 }
}
