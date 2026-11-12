$ErrorActionPreference='Stop'
$source=Join-Path (Split-Path -Parent $PSScriptRoot) 'packaging\StandbyPolicy.cs'
$tests=@'
public static class StandbyFixture {
 public static void Run() {
  var p=new StandbyPolicy(0);if(p.MayStop(60000))throw new System.Exception("Unknown operations must fail closed");
  p.SetOperations(true,false);if(p.Heartbeat("attacker",false,0))throw new System.Exception("Unauthenticated heartbeat");
  p.Heartbeat("desktop",true,0);p.Heartbeat("phone",true,10000);p.Disconnect("desktop",11000);
  if(p.MayStop(50000))throw new System.Exception("Live phone must retain backend");
  p.SetOperations(true,true);if(p.MayStop(100000))throw new System.Exception("Protected operation");
  p.SetOperations(true,false);if(!p.MayStop(100000))throw new System.Exception("Expired phone must permit standby");
  for(int i=0;i<100;i++){long t=200000+i*100000;if(!p.Heartbeat("desktop"+i,true,t))throw new System.Exception("Expired clients leaked capacity");if(p.MayStop(t+44000))throw new System.Exception("Early stop");if(!p.MayStop(t+45000))throw new System.Exception("Deadline");}
  if(p.MayStop(1))throw new System.Exception("Clock regression must fail closed");
 }
}
'@
Add-Type -TypeDefinition ((Get-Content -LiteralPath $source -Raw)+$tests)
[StandbyFixture]::Run()
Write-Output 'PASS native standby decision core: unauthorized clients, multiple devices, protected/unknown operations, deadline, clock regression and 100 cycles (no processes stopped)'
