param([Parameter(Mandatory=$true)][ValidateSet('sleep','restart','shutdown')][string]$Action)
$ErrorActionPreference='Stop'
function Result($state,$code=$null,$message=$null,$windowsError=$null){[Console]::Out.WriteLine((@{state=$state;code=$code;message=$message;windowsError=$windowsError}|ConvertTo-Json -Compress));[Console]::Out.Flush()}
try {
Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class RovarinPower {
 [StructLayout(LayoutKind.Sequential)] struct LUID { public uint Low; public int High; }
 [StructLayout(LayoutKind.Sequential)] struct PRIVILEGE { public uint Count; public LUID Luid; public uint Attributes; }
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
 [DllImport("advapi32.dll", CharSet=CharSet.Unicode,SetLastError=true)] static extern bool LookupPrivilegeValue(string system,string name,out LUID luid);
 [DllImport("advapi32.dll", SetLastError=true)] static extern bool AdjustTokenPrivileges(IntPtr token,bool disable,ref PRIVILEGE privilege,uint size,IntPtr previous,IntPtr returned);
 [DllImport("advapi32.dll", CharSet=CharSet.Unicode,SetLastError=true)] static extern bool InitiateSystemShutdownEx(string machine,string message,uint timeout,bool force,bool reboot,uint reason);
 [DllImport("powrprof.dll", SetLastError=true)] [return:MarshalAs(UnmanagedType.I1)] public static extern bool IsPwrSuspendAllowed();
 [DllImport("powrprof.dll", SetLastError=true)] [return:MarshalAs(UnmanagedType.I1)] static extern bool SetSuspendState([MarshalAs(UnmanagedType.I1)]bool hibernate,[MarshalAs(UnmanagedType.I1)]bool force,[MarshalAs(UnmanagedType.I1)]bool disableWake);
 public static void Prepare() {
  IntPtr token;if(!OpenProcessToken(GetCurrentProcess(),0x28,out token))throw new Win32Exception(Marshal.GetLastWin32Error());
  try { LUID luid;if(!LookupPrivilegeValue(null,"SeShutdownPrivilege",out luid))throw new Win32Exception(Marshal.GetLastWin32Error());
   PRIVILEGE p=new PRIVILEGE {Count=1,Luid=luid,Attributes=2};
   if(!AdjustTokenPrivileges(token,false,ref p,0,IntPtr.Zero,IntPtr.Zero))throw new Win32Exception(Marshal.GetLastWin32Error());
   int error=Marshal.GetLastWin32Error();if(error!=0)throw new Win32Exception(error);
  }finally{CloseHandle(token);}
 }
 public static void Execute(string action) {
  bool ok;
  if(action=="sleep")ok=SetSuspendState(false,false,false);
  else if(action=="restart"||action=="shutdown")ok=InitiateSystemShutdownEx(null,null,0,false,action=="restart",0x80040000);
  else throw new ArgumentException("Unsupported power action");
  if(!ok)throw new Win32Exception(Marshal.GetLastWin32Error());
 }
}
"@
 if($Action -eq 'sleep' -and ![RovarinPower]::IsPwrSuspendAllowed()){Result 'failed' 'sleep-unavailable' 'Sleep is unavailable in this Windows power configuration. Hibernation was not requested.';exit 2}
 [RovarinPower]::Prepare()
 Result 'ready'
 if([Console]::In.ReadLine() -cne 'execute'){exit 3}
 Result 'invoking'
 [RovarinPower]::Execute($Action)
 if($Action -eq 'sleep'){Result 'returned'}else{Result 'initiated'}
} catch {
 $errorCode=$_.Exception.GetBaseException().NativeErrorCode
 $message='Windows refused the power request.';$code='windows-error'
 if($errorCode -in @(5,1300,1314)){$code='permission-denied';$message='Your Windows account is not allowed to control this PC’s power. No administrator bypass was attempted.'}
 elseif($errorCode -in @(1115,1190)){$code='shutdown-in-progress';$message='Windows already has a shutdown or restart in progress.'}
 elseif($errorCode -eq 21){$code='windows-not-ready';$message='Windows is not ready for a power request. Check the PC and try again.'}
 Result 'failed' $code $message $errorCode
 exit 1
}
