// Fixed protected lifecycle; no input paths, custom service names or execution commands.
using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.ServiceProcess;
using System.Security.Principal;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Runtime.InteropServices;
using System.Threading;
internal sealed partial class MaintenanceFoundation {
    const string Name="RovarinMaintenanceFoundation";
    static readonly string DigestPath=Path.Combine(Root,"RovarinMaintenanceService.exe.sha256");
    static readonly string JournalPath=Path.Combine(Root,"provisioning.pending");
    [DllImport("advapi32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr CreateService(IntPtr manager,string name,string display,uint access,uint type,uint start,uint error,string binary,string group,IntPtr tag,string dependencies,string account,string password);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool SetServiceObjectSecurity(IntPtr service,uint information,IntPtr descriptor);
    [DllImport("advapi32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool ChangeServiceConfig2(IntPtr service,uint level,IntPtr value);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool DeleteService(IntPtr service);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool QueryServiceStatusEx(IntPtr service,int level,out ServiceStatus status,uint size,out uint needed);
    [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
    [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process,uint flags,StringBuilder image,ref uint length);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
    [StructLayout(LayoutKind.Sequential)] struct ServiceStatus {public uint Type,State,Controls,Win32,Specific,Checkpoint,Hint,Pid,Flags;}
    [StructLayout(LayoutKind.Sequential)] struct RecoveryAction {public uint Type,Delay;}
    [StructLayout(LayoutKind.Sequential)] struct RecoveryPolicy {public uint Reset;public IntPtr Reboot,Command;public uint Count;public IntPtr Actions;}
    internal static bool ElevatedInteractive() {return Environment.UserInteractive && new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator);}
    internal static void ValidateImageDigest() {
        ProtectedPath(DigestPath,false);
        string expected=File.ReadAllText(DigestPath).Trim();
        if(!System.Text.RegularExpressions.Regex.IsMatch(expected,@"\A[0-9a-f]{64}\z"))throw new InvalidDataException("invalid-image-digest");
        using(var file=new FileStream(Image,FileMode.Open,FileAccess.Read,FileShare.Read))using(var sha=SHA256.Create()) {
            string actual=BitConverter.ToString(sha.ComputeHash(file)).Replace("-","").ToLowerInvariant();
            if(actual!=expected)throw new InvalidDataException("image-replaced");
        }
    }
    static uint RegisteredPid(bool running = true) {
        IntPtr manager=OpenSCManager(null,null,1);if(manager==IntPtr.Zero)throw new InvalidDataException("service-unavailable");
        try {IntPtr service=OpenService(manager,Name,4);if(service==IntPtr.Zero)throw new InvalidDataException("service-unavailable");
            try {ServiceStatus status;uint needed;if(!QueryServiceStatusEx(service,0,out status,(uint)Marshal.SizeOf(typeof(ServiceStatus)),out needed) || (running && status.State!=4) || status.Pid==0)throw new InvalidDataException("service-not-running");return status.Pid;}
            finally{CloseServiceHandle(service);}
        }finally{CloseServiceHandle(manager);}
    }
    // SCM identity + a held query-only process handle, rather than requiring access to a SYSTEM token.
    static bool VerifiedServicePeer(uint pid) {
        if(RegisteredPid()!=pid)return false;
        IntPtr process=OpenProcess(0x1000,false,pid);if(process==IntPtr.Zero)return false;
        try {uint length=32768,exit;var name=new StringBuilder((int)length);
            return QueryFullProcessImageName(process,0,name,ref length) && String.Equals(name.ToString(),Image,StringComparison.OrdinalIgnoreCase) && GetExitCodeProcess(process,out exit) && exit==259 && RegisteredPid()==pid;
        }finally{CloseHandle(process);}
    }
    static void SecureService(IntPtr service) {
        IntPtr descriptor;uint length;
        // Authenticated users may QUERY only. No START/STOP/CHANGE_CONFIG/DELETE rights.
        if(!ConvertStringSecurityDescriptorToSecurityDescriptor("O:BAG:BAD:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;CCLCRC;;;AU)",1,out descriptor,out length))throw new InvalidDataException("service-acl");
        try {if(!SetServiceObjectSecurity(service,5,descriptor))throw new InvalidDataException("service-acl");}finally{LocalFree(descriptor);}
        int size=Marshal.SizeOf(typeof(RecoveryAction));IntPtr actions=Marshal.AllocHGlobal(size*3),policy=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(RecoveryPolicy))),flag=Marshal.AllocHGlobal(4);
        try {
            Marshal.StructureToPtr(new RecoveryAction{Type=1,Delay=5000},actions,false);
            Marshal.StructureToPtr(new RecoveryAction{Type=1,Delay=30000},IntPtr.Add(actions,size),false);
            Marshal.StructureToPtr(new RecoveryAction{Type=0,Delay=0},IntPtr.Add(actions,size*2),false);
            Marshal.StructureToPtr(new RecoveryPolicy{Reset=86400,Count=3,Actions=actions},policy,false);
            if(!ChangeServiceConfig2(service,2,policy))throw new InvalidDataException("service-recovery");
            Marshal.WriteInt32(flag,1);if(!ChangeServiceConfig2(service,4,flag))throw new InvalidDataException("service-recovery");
        }finally{Marshal.FreeHGlobal(actions);Marshal.FreeHGlobal(policy);Marshal.FreeHGlobal(flag);}
    }
    static void StopOwnedService() {
        ValidateServiceRegistration();
        uint pid=0;try{pid=RegisteredPid(false);}catch(InvalidDataException){}
        IntPtr process=pid==0?IntPtr.Zero:OpenProcess(0x1000,false,pid);
        if(pid!=0 && process==IntPtr.Zero)throw new InvalidDataException("service-process-unverified");
        try {
            if(process!=IntPtr.Zero) {
                uint length=32768;var image=new StringBuilder((int)length);
                if(!QueryFullProcessImageName(process,0,image,ref length) || !String.Equals(image.ToString(),Image,StringComparison.OrdinalIgnoreCase))throw new InvalidDataException("service-process-unverified");
            }
            using(var control=new ServiceController(Name)) {
                control.Refresh();if(control.Status!=ServiceControllerStatus.Stopped) {control.Stop();control.WaitForStatus(ServiceControllerStatus.Stopped,TimeSpan.FromSeconds(20));}
            }
            if(process!=IntPtr.Zero) {
                var end=DateTime.UtcNow.AddSeconds(5);uint exit;
                while(true) {
                    if(!GetExitCodeProcess(process,out exit))throw new InvalidDataException("service-process-unverified");
                    if(exit!=259)break;
                    if(DateTime.UtcNow>end)throw new InvalidDataException("service-process-remains");Thread.Sleep(100);
                }
            }
        }finally{if(process!=IntPtr.Zero)CloseHandle(process);}
    }
    // Small injectable transaction is also exercised without SCM in automated tests.
    internal static void ProvisionTransaction(Action prepare,Action register,Action configure,Action start,Action enroll,Action rollback) {
        bool attempted=false;
        prepare();
        try {attempted=true;register();configure();start();enroll();}
        catch {if(attempted)rollback();throw;}
    }
    static void SecureJournal() {
        var acl=new FileSecurity();acl.SetAccessRuleProtection(true,false);acl.SetOwner(new SecurityIdentifier(AdminSid));
        foreach(string sid in new[]{SystemSid,AdminSid})acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),FileSystemRights.FullControl,AccessControlType.Allow));
        File.SetAccessControl(JournalPath,acl);ProtectedPath(JournalPath,false);
    }
    static int Provision(string owner) {
        ValidateDeployment();if(!ElevatedInteractive() || !ValidOwner(owner))return 1;
        var existing=Load();if(existing.Owner!="" && existing.Owner!=owner)throw new InvalidDataException("owner-conflict");
        // Never automatically enable on startup/recovery. Explicit UAC-authorized enrollment is last.
        IntPtr manager=OpenSCManager(null,null,3);if(manager==IntPtr.Zero)throw new InvalidDataException("service-manager");
        IntPtr service=IntPtr.Zero;bool created=false,startAttempted=false;
        try {
            ProvisionTransaction(delegate {
                if(File.Exists(JournalPath))ProtectedPath(JournalPath,false);
                using(var file=new FileStream(JournalPath,FileMode.OpenOrCreate,FileAccess.Write,FileShare.None)){file.SetLength(0);file.Flush(true);}
                SecureJournal();
                Save(new Policy{Owner=owner,Enabled=false,Generation=checked(existing.Generation+1)});
            },delegate {
                service=OpenService(manager,Name,0x000F01FF);
                if(service!=IntPtr.Zero) {ValidateServiceRegistration();return;}
                if(Marshal.GetLastWin32Error()!=1060)throw new InvalidDataException("service-conflict");
                service=CreateService(manager,Name,"Rovarin Maintenance Foundation",0x000F01FF,0x10,2,1,"\""+Image+"\"",null,IntPtr.Zero,null,"LocalSystem",null);
                if(service==IntPtr.Zero)throw new InvalidDataException("service-create");created=true;
            },delegate {SecureService(service);ValidateServiceRegistration();},delegate {
                startAttempted=true;
                using(var control=new ServiceController(Name)){control.Refresh();if(control.Status!=ServiceControllerStatus.Running){control.Start();control.WaitForStatus(ServiceControllerStatus.Running,TimeSpan.FromSeconds(20));}}
            },delegate {if(Client("enroll",owner)!=0)throw new InvalidDataException("enrollment-failed");},delegate {
                // Only revoke/stop/delete a registration whose fixed identity was independently validated.
                Save(new Policy{Owner=owner,Enabled=false,Generation=checked(Load().Generation+1)});
                if(service!=IntPtr.Zero) {if(!created || startAttempted){ValidateServiceRegistration();StopOwnedService();}if(created && !DeleteService(service))throw new InvalidDataException("rollback-removal-failed");}
            });
            File.Delete(JournalPath);Console.WriteLine("enabled");return 0;
        }finally{if(service!=IntPtr.Zero)CloseServiceHandle(service);CloseServiceHandle(manager);}
    }
    static int PreparePackageUpdate() {
        ValidateDeployment();if(!ElevatedInteractive())return 1;
        IntPtr manager=OpenSCManager(null,null,1);if(manager==IntPtr.Zero)throw new InvalidDataException("service-manager");
        try {IntPtr service=OpenService(manager,Name,1);if(service!=IntPtr.Zero){CloseServiceHandle(service);return RemoveFoundation();}if(Marshal.GetLastWin32Error()!=1060)throw new InvalidDataException("service-unverified");}finally{CloseServiceHandle(manager);}
        var policy=Load();if(policy.Owner!="")Save(new Policy{Owner=policy.Owner,Enabled=false,Generation=checked(policy.Generation+1)});
        Console.WriteLine("removed");return 0;
    }
    static int RemoveFoundation() {
        ValidateDeployment();if(!ElevatedInteractive())return 1;
        // Revoke durably BEFORE stopping. Retain the protected tombstone across reinstall/recovery.
        var policy=Load();if(policy.Owner!="")Save(new Policy{Owner=policy.Owner,Enabled=false,Generation=checked(policy.Generation+1)});
        ValidateServiceRegistration();StopOwnedService();
        IntPtr manager=OpenSCManager(null,null,1);if(manager==IntPtr.Zero)throw new InvalidDataException("service-manager");
        try {IntPtr service=OpenService(manager,Name,0x00010000);if(service==IntPtr.Zero)throw new InvalidDataException("service-unavailable");
            try {if(!DeleteService(service))throw new InvalidDataException("service-remove");}finally{CloseServiceHandle(service);}
        }finally{CloseServiceHandle(manager);}
        if(File.Exists(JournalPath)){ProtectedPath(JournalPath,false);File.Delete(JournalPath);}
        // Running executable is deliberately retained: protected package removal owns final binary cleanup.
        Console.WriteLine("removed");return 0;
    }
    static void LifecycleSelfTest() {
        Action<bool> assert=delegate(bool ok){if(!ok)throw new Exception("lifecycle test failed");};
        for(int failure=0;failure<5;failure++) {
            int stage=0,rollbacks=0;var calls=new System.Collections.Generic.List<int>();int selected=failure;
            Action step=delegate {calls.Add(stage);if(stage++==selected)throw new IOException("fixture failure");};
            try {ProvisionTransaction(step,step,step,step,step,delegate{rollbacks++;});assert(false);}catch(IOException){}
            assert(rollbacks==(failure==0?0:1));assert(calls.Count==failure+1);
        }
        int completed=0;Action pass=delegate{completed++;};ProvisionTransaction(pass,pass,pass,pass,pass,delegate{assert(false);});assert(completed==5);
        var revoked=new Policy{Owner="S-1-5-21-1-2-3-1001",Enabled=false,Generation=5};
        assert(Dispatch(revoked,revoked.Owner,false,"x","1|x|status",delegate{assert(false);})=="disabled" && revoked.Generation==5);
        Console.WriteLine("PASS: lifecycle transaction ordering, interrupted stages, rollback and revoked recovery state");
    }
}