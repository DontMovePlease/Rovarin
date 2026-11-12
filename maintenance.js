const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const maintenanceService = require('./maintenance-service');

let serviceClient = maintenanceService.createClient();

// Maintenance State
let isRunning = false;
let currentTask = null;
const history = [];
const MAX_HISTORY = 20;
const ADMIN_RELAUNCH_NOTE = "Administrator approval is required for this action.";

// Admin rights cache
let cachedIsAdmin = null;
let lastAdminCheck = 0;
let adminCheckInFlight = false;
const adminCheckCallbacks = [];

function checkIsAdmin(callback) {
  const now = Date.now();
  if (cachedIsAdmin !== null && now - lastAdminCheck < 30000) {
    return callback(cachedIsAdmin);
  }
  adminCheckCallbacks.push(callback);
  if (adminCheckInFlight) return;
  adminCheckInFlight = true;
  const done = (err) => {
    cachedIsAdmin = !err;
    lastAdminCheck = now;
    adminCheckInFlight = false;
    const callbacks = adminCheckCallbacks.splice(0);
    callbacks.forEach(done => done(cachedIsAdmin));
  };
  try { execFile('net', ['session'], { windowsHide: true, timeout: 5000 }, done); }
  catch (error) { done(error); }
}

// Log an event to task logs and history
function appendLog(task, message, level = 'info') {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  const entry = { time, message: String(message).slice(0, 2000), level };
  task.logs.push(entry);
  if (task.logs.length > 500) task.logs.shift();
  if (task.onProgress) {
    task.onProgress(task, entry);
  }
}

function addToHistory(task, success, summary) {
  const durationSec = Math.round((Date.now() - task.startTime) / 1000);
  const entry = {
    id: task.id,
    title: task.title,
    timestamp: new Date().toLocaleTimeString('en-US', { hour12: false }),
    date: new Date().toLocaleDateString('en-US'),
    duration: `${durationSec}s`,
    success,
    summary,
    status: task.status
  };
  history.unshift(entry);
  if (history.length > MAX_HISTORY) history.pop();
}

// Allowlisted Action Definitions
const ACTIONS = {
  boost: {
    id: 'boost', title: 'Boost', category: 'Cleanup', requiresAdmin: false,
    requiresConfirmation: true,
    description: 'Reclaims background-app RAM and cleans temporary files without closing your apps.'
  },
  clean_temp: {
    id: 'clean_temp',
    title: 'Clean Temporary Files',
    category: 'Cleanup',
    requiresAdmin: false,
    description: "Cleans safe Windows temporary files and the current user's temp directory."
  },
  empty_recycle_bin: {
    id: 'empty_recycle_bin',
    title: 'Empty Recycle Bin',
    category: 'Cleanup',
    requiresAdmin: false,
    description: 'Permanently empties the Windows Recycle Bin.'
  },
  clear_dns: {
    id: 'clear_dns',
    title: 'Clear DNS Cache',
    category: 'Cleanup',
    requiresAdmin: true,
    description: 'Flushes the Windows DNS resolver cache.'
  },
  windows_repair: {
    id: 'windows_repair',
    title: 'Windows System Repair',
    category: 'Windows Repair',
    requiresAdmin: true,
    description: 'Automated DISM Component Store repair followed by SFC system file check.'
  },
  sfc_scan: {
    id: 'sfc_scan',
    title: 'Scan Windows System Files',
    category: 'Windows Repair',
    requiresAdmin: true,
    description: 'Runs SFC /scannow to inspect and repair protected system files.'
  },
  dism_check: {
    id: 'dism_check',
    title: 'Check Windows Component Store',
    category: 'Windows Repair',
    requiresAdmin: true,
    description: 'Diagnostic check of Windows Component Store health without making modifications.'
  },
  reset_network: {
    id: 'reset_network',
    title: 'Reset Network Settings',
    category: 'Network',
    requiresAdmin: true,
    description: 'Resets the Windows TCP/IP stack and Winsock catalog.'
  },
  renew_network: {
    id: 'renew_network',
    title: 'Renew Network Connection',
    category: 'Network',
    requiresAdmin: false,
    description: 'Refreshes IP address leases via DHCP without breaking Tailscale.'
  },
  restart_explorer: {
    id: 'restart_explorer',
    title: 'Restart Windows Explorer',
    category: 'Explorer',
    requiresAdmin: false,
    description: 'Restarts explorer.exe to resolve taskbar or shell issues.'
  },
};

// Execute allowlisted action
function runAction(actionId, onProgress, onComplete, options = {}) {
  if (isRunning) {
    return { success: false, error: 'A maintenance operation is already running.' };
  }

  const actionDef = Object.hasOwn(ACTIONS, actionId) ? ACTIONS[actionId] : null;
  if (!actionDef) {
    return { success: false, error: 'Invalid or unauthorized maintenance action.' };
  }

  isRunning = true;
  currentTask = {
    id: actionDef.id,
    title: actionDef.title,
    category: actionDef.category,
    status: 'running',
    currentStep: 1,
    totalSteps: 1,
    stepTitle: actionDef.title,
    startTime: Date.now(),
    logs: [],
    result: null,
    onProgress
  };

  appendLog(currentTask, `Starting operation: ${actionDef.title}...`);

  // Dispatch to appropriate handler
  let finished = false;
  const finish = (success, summary, detailedResult = null) => {
    if (finished) return;
    finished = true;
    // Partial completion is not full success, including older helper results.
    if (detailedResult?.code === 'partially-completed' || detailedResult?.code === 'locked-files-only') success = false;
    currentTask.status = detailedResult?.code === 'uac-cancelled'
      ? 'cancelled'
      : (detailedResult?.code === 'partially-completed' || detailedResult?.code === 'locked-files-only')
        ? 'partially-completed'
        : detailedResult?.code === 'verification-unavailable'
          ? 'unverified'
          : success ? 'completed' : 'failed';
    currentTask.result = { success, summary, detailedResult };
    appendLog(currentTask, summary, currentTask.status === 'unverified' ? 'warn' : success ? 'success' : 'error');
    addToHistory(currentTask, success, summary);
    isRunning = false;
    if (onComplete) onComplete(currentTask);
  };

  checkIsAdmin((isAdmin) => {
    serviceClient.status().then(serviceStatus => {
      if (actionDef.requiresAdmin) {
        if (serviceStatus && serviceStatus.enabled) {
          executeServiceAction(currentTask, finish);
          return;
        }
        if (options.isLocal === false) {
          finish(false, 'Administrator maintenance is not enabled on this PC. Enable it in Settings on your desktop first.', { code: 'service-disabled' });
          return;
        }
        if (!isAdmin) {
          executeElevatedAction(currentTask, finish);
          return;
        }
      }

      try {
        switch (actionId) {
          case 'boost':
            executeBoost(currentTask, finish).catch(() => finish(false, 'Boost could not be completed.'));
            break;
          case 'clean_temp':
            executeCleanTemp(currentTask, finish).catch(() => finish(false, 'Temporary cleanup could not be completed.'));
            break;
          case 'empty_recycle_bin':
            executeEmptyRecycleBin(currentTask, finish);
            break;
          case 'clear_dns':
            executeClearDns(currentTask, finish);
            break;
          case 'windows_repair':
            executeWindowsRepair(currentTask, finish, isAdmin);
            break;
          case 'sfc_scan':
            executeSfcScan(currentTask, finish, isAdmin);
            break;
          case 'dism_check':
            executeDismCheck(currentTask, finish, isAdmin);
            break;
          case 'reset_network':
            executeResetNetwork(currentTask, finish, isAdmin);
            break;
          case 'renew_network':
            executeRenewNetwork(currentTask, finish);
            break;
          case 'restart_explorer':
            executeRestartExplorer(currentTask, finish);
            break;
          default:
            finish(false, 'Unknown action.');
        }
      } catch (err) {
        finish(false, `Unexpected error during execution: ${err.message}`);
      }
    }).catch(err => {
      finish(false, `Maintenance status check failed: ${err.message}`);
    });
  });

  return { success: true, message: `Operation ${actionDef.title} started.` };
}

function consumeMaintenanceProcess(child, task, complete, timeoutMs = 32 * 60 * 1000) {
  let buffer = '', result = null, settled = false, outputBytes = 0, failure = null;
  const done = (code, reason) => {
    if (settled) return; settled = true; clearTimeout(timeout);
    if (reason) return complete(false, reason.summary, { code: reason.code });
    if (!result) return complete(false, 'The maintenance operation stopped without confirming a result.', { code: 'helper-crashed' });
    if (result.success && code !== 0) return complete(false, 'The maintenance operation could not confirm a safe shutdown.', { code: 'shutdown-unconfirmed' });
    complete(result.success, result.summary, { code: result.code, exitCode: result.exitCode });
  };
  const timeout = setTimeout(() => { failure = { code: 'timeout', summary: 'The maintenance operation timed out.' }; child.kill(); }, timeoutMs);
  timeout.unref?.();
  function invalid() { result = null; failure = { code: 'invalid-output', summary: 'The maintenance operation returned an invalid result.' }; child.kill(); }
  child.stdout.on('data', chunk => {
    outputBytes += chunk.length;
    if (outputBytes > 2 * 1024 * 1024) return invalid();
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message; try { message = JSON.parse(line); } catch (_) { return invalid(); }
      if (!message || message.action !== task.id || !['progress', 'log', 'result'].includes(message.type)) return invalid();
      if (message.type === 'result') {
        const codes = ['completed', 'partially-completed', 'uac-cancelled', 'launch-failed', 'connection-failed', 'identity-mismatch', 'helper-failed', 'helper-crashed', 'shutdown-unconfirmed', 'timeout', 'tool-unavailable', 'tool-failed', 'operation-failed', 'service-unavailable', 'service-disabled'];
        const isSuccessCode = message.code === 'completed';
        const isPartial = message.code === 'partially-completed';
        if (typeof message.success !== 'boolean' || !codes.includes(message.code) || (!isPartial && message.success !== isSuccessCode) || typeof message.summary !== 'string' || message.summary.length > 2000 || (message.exitCode !== null && !Number.isInteger(message.exitCode))) return invalid();
        result = { ...message, success: isSuccessCode };
      } else {
        if (typeof message.message !== 'string' || message.message.length > 2000) return invalid();
        if (message.type === 'progress') {
          if (!Number.isInteger(message.step) || !Number.isInteger(message.total) || message.step < 0 || message.total < 1 || message.total > 4 || message.step > message.total) return invalid();
          task.currentStep = message.step; task.totalSteps = message.total; task.stepTitle = message.message;
        }
        appendLog(task, message.message);
      }
    }
    if (buffer.length > 8192) return invalid();
  });
  child.stderr.on('data', () => {});
  child.once('error', () => done(-1, { code: 'launch-failed', summary: 'Windows could not start the maintenance operation.' }));
  child.once('close', code => done(code, failure));
}

function executeServiceAction(task, finish) {
  appendLog(task, 'Starting action via authorized Rovarin maintenance service...');
  let child;
  try {
    child = serviceClient.run(task.id);
  } catch (_) {
    return finish(false, 'The maintenance service could not be started.', { code: 'service-unavailable' });
  }
  // Native service: 35-minute work + 1-minute result window, then a bounded
  // outer cleanup margin. The local one-shot fallback keeps its 32-minute guard.
  consumeMaintenanceProcess(child, task, finish, 37 * 60 * 1000);
}

// Compile only this fixed Rovarin source into a unique, server-owned temporary
// directory. Never accept a destination/source/compiler/action argument from a client.
function executeElevatedAction(task, finish) {
  if (process.platform !== 'win32') return finish(false, 'Administrator-approved maintenance is available on Windows only.', { code: 'unsupported' });
  let directory;
  try { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rovarin-maintenance-')); }
  catch (_) { return finish(false, 'The maintenance helper workspace could not be created.', { code: 'helper-unavailable' }); }
  const helper = path.join(directory, 'RovarinMaintenance.exe');
  const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const cleanup = () => {
    try { fs.rmSync(directory, { recursive: true, force: true }); }
    catch (_) { appendLog(task, 'Temporary helper cleanup was deferred because Windows still holds the file.', 'warn'); }
  };
  const complete = (success, summary, detail) => { cleanup(); finish(success, summary, detail); };
  appendLog(task, 'Preparing this action for local Windows administrator approval.');
  try {
    execFile(compiler, ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/r:System.Web.Extensions.dll', '/out:' + helper, path.join(__dirname, 'scripts', 'maintenance-elevated.cs')],
      { windowsHide: true, timeout: 30000, maxBuffer: 8192 }, (error) => {
        if (error) return complete(false, 'The fixed maintenance helper could not be prepared.', { code: 'helper-unavailable' });
        let child;
        try { child = spawn(helper, [task.id, String(process.pid)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
        catch (_) { return complete(false, 'Windows could not start the maintenance helper.', { code: 'launch-failed' }); }
        consumeMaintenanceProcess(child, task, complete);
      });
  } catch (_) { complete(false, 'The fixed maintenance helper could not be prepared.', { code: 'helper-unavailable' }); }
}

// On-demand, unelevated, fixed policy. A held handle binds every query and trim.
const BOOST_MEMORY_SOURCE = String.raw`
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
public static class RovarinBoostMemory {
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr process,int flags,StringBuilder path,ref int size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessCritical(IntPtr process,out bool critical);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out long creation,out long exit,out long kernel,out long user);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window,uint flags);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out int pid);
  [DllImport("psapi.dll",SetLastError=true)] static extern bool EmptyWorkingSet(IntPtr process);
  [DllImport("psapi.dll",SetLastError=true)] static extern bool GetProcessMemoryInfo(IntPtr process,out Counters counters,uint size);
  [StructLayout(LayoutKind.Sequential)] struct Counters { public uint cb,faults; public UIntPtr peak,working,peakPaged,paged,peakNonpaged,nonpaged,pagefile,peakPagefile; }
  public sealed class Result { public bool success=true; public int eligible,trimmed,failed; public long workingSetReducedBytes,eligibleWorkingSetBytes; }
  static string GetForegroundProcessImage(out int activePid, out int ownerPid) {
    activePid = 0; ownerPid = 0;
    try {
      var window = GetForegroundWindow();
      if (window == IntPtr.Zero) return null;
      GetWindowThreadProcessId(window, out activePid);
      GetWindowThreadProcessId(GetAncestor(window, 3), out ownerPid);
      if (activePid <= 4) return null;
      IntPtr h = OpenProcess(0x1000, false, activePid);
      if (h == IntPtr.Zero) h = OpenProcess(0x0400, false, activePid);
      if (h == IntPtr.Zero) return null;
      try {
        var sb = new StringBuilder(1024); int len = sb.Capacity;
        if (QueryFullProcessImageName(h, 0, sb, ref len)) return Path.GetFullPath(sb.ToString());
      } finally { CloseHandle(h); }
    } catch {}
    return null;
  }
  static bool Foreground(int pid) { int active,owner; var window=GetForegroundWindow();GetWindowThreadProcessId(window,out active);GetWindowThreadProcessId(GetAncestor(window,3),out owner);return active==pid||owner==pid; }
  // Kept separate so disposable native fixtures exercise the exact production policy
  // against only their own process, without touching the host's applications.
  internal static Result RunCandidates(Process[] candidates,string root,int serverPid,string[] securityRoots=null,bool inspectOnly=false) {
    var result=new Result();var clock=Stopwatch.StartNew();var self=Process.GetCurrentProcess();
    int maxEligible=48;
    ulong minWorking=16UL*1024*1024;
    string sid=WindowsIdentity.GetCurrent().User.Value,windows=Environment.GetFolderPath(Environment.SpecialFolder.Windows)+Path.DirectorySeparatorChar;
    root=Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar)+Path.DirectorySeparatorChar;
    int fgActivePid, fgOwnerPid;
    string fgImage = GetForegroundProcessImage(out fgActivePid, out fgOwnerPid);
    try { foreach(var candidate in candidates) {
      IntPtr handle=IntPtr.Zero,token=IntPtr.Zero;
      try {
        if(clock.ElapsedMilliseconds>8000||result.eligible>=maxEligible)break;
        int pid=candidate.Id;
        if(pid==serverPid||pid<=4||candidate.SessionId!=self.SessionId||pid==fgActivePid||pid==fgOwnerPid)continue;
        var window=candidate.MainWindowHandle;int windowPid;
        if(window!=IntPtr.Zero) {
          if(!IsIconic(window))continue;
          GetWindowThreadProcessId(window,out windowPid);if(windowPid!=pid)continue;
        }
        long expected=candidate.StartTime.ToUniversalTime().ToFileTimeUtc(),created,exited,kernel,user;
        handle=OpenProcess(0x0400|0x0100|0x0010,false,pid);if(handle==IntPtr.Zero)continue;
        bool critical;
        if(!GetProcessTimes(handle,out created,out exited,out kernel,out user)||created!=expected||exited!=0||!IsProcessCritical(handle,out critical)||critical)continue;
        var image=new StringBuilder(32768);int length=image.Capacity;
        if(!QueryFullProcessImageName(handle,0,image,ref length))continue;
        string file=Path.GetFullPath(image.ToString());
        if(fgImage!=null&&string.Equals(file,fgImage,StringComparison.OrdinalIgnoreCase))continue;
        if(file.StartsWith(windows,StringComparison.OrdinalIgnoreCase)||file.StartsWith(root,StringComparison.OrdinalIgnoreCase)||Regex.IsMatch(Path.GetFileNameWithoutExtension(file),@"(?i)rovarin|defender|msmpeng|nissrv|mssense|security|antivirus|firewall|credential|password|keepass|bitwarden|1password|auth|malware|avast|avg|avira|avp|kaspersky|eset|norton|mcafee|sophos|bitdefender|trendmicro|emsisoft|fsecure|webroot|sentinel|crowdstrike|forti|symantec|comodo|virtualbox|vmware|vbox|antigravity|localharness|t3code"))continue;
        bool protectedSecurity=false;
        foreach(string securityRoot in securityRoots??new string[0])if(file.StartsWith(Path.GetFullPath(securityRoot).TrimEnd(Path.DirectorySeparatorChar)+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase)){protectedSecurity=true;break;}
        if(protectedSecurity)continue;
        if(!OpenProcessToken(handle,8,out token))continue;
        using(var identity=new WindowsIdentity(token)){if(identity.User==null||identity.User.Value!=sid)continue;}
        Counters before,after;uint size=(uint)Marshal.SizeOf(typeof(Counters));
        if(!GetProcessMemoryInfo(handle,out before,size)||before.working.ToUInt64()<minWorking)continue;
        if(Foreground(pid)||(window!=IntPtr.Zero&&!IsIconic(window)))continue;
        result.eligibleWorkingSetBytes+=(long)before.working.ToUInt64();
        if(inspectOnly){result.eligible++;continue;}
        if(!EmptyWorkingSet(handle)||!GetProcessMemoryInfo(handle,out after,size)){result.eligible++;result.failed++;continue;}
        result.eligible++;
        result.trimmed++;result.workingSetReducedBytes+=Math.Max(0,(long)before.working.ToUInt64()-(long)after.working.ToUInt64());
      } catch { /* Denied/unverifiable processes are ineligible, never bypassed. */ }
      finally { if(token!=IntPtr.Zero)CloseHandle(token);if(handle!=IntPtr.Zero)CloseHandle(handle); }
    } } finally {foreach(var candidate in candidates)candidate.Dispose();self.Dispose();}
    result.success=result.failed==0;return result;
  }
  public static Result Run(string root,int serverPid,string[] securityRoots,bool inspectOnly=false) { return RunCandidates(Process.GetProcesses(),root,serverPid,securityRoots,inspectOnly); }
}`;

function trimBackgroundMemory(inspectOnly=false) {
  if (process.platform !== 'win32') return Promise.resolve({ success: false, code: 'unsupported' });
  const script = `$ErrorActionPreference='Stop';try {
  $products=@(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct -OperationTimeoutSec 3 -ErrorAction Stop)
  if($products.Count -eq 0){throw 'Security inventory unavailable'}
  $securityRoots=@(foreach($product in $products){
    $image=[Environment]::ExpandEnvironmentVariables([string]$product.pathToSignedProductExe).Trim('"')
    if($image -match '^windowsdefender:'){continue}
    if(-not [IO.Path]::IsPathRooted($image) -or [IO.Path]::GetExtension($image) -ine '.exe'){throw 'Unverified security location'}
    [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($image))
  })
  Add-Type -TypeDefinition @'
${BOOST_MEMORY_SOURCE}
'@; [RovarinBoostMemory]::Run('${__dirname.replace(/'/g,"''")}',${process.pid},[string[]]$securityRoots,${inspectOnly?'$true':'$false'}) | ConvertTo-Json -Compress } catch { @{success=$false;code='memory-unavailable'} | ConvertTo-Json -Compress }`;
  return new Promise(resolve => execFile('powershell.exe', ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
    { windowsHide:true, timeout:15000, maxBuffer:8192 }, (error,stdout) => {
      try {
        const value = JSON.parse(stdout);
        if (error || ![true,false].includes(value.success) || ![value.eligible,value.trimmed,value.failed,value.workingSetReducedBytes].every(n => Number.isSafeInteger(n) && n >= 0) || value.eligible>256 || (inspectOnly ? value.trimmed!==0||value.failed!==0||!Number.isSafeInteger(value.eligibleWorkingSetBytes) : value.trimmed+value.failed!==value.eligible) || value.success!==(value.failed===0)) throw Error();
        resolve(value);
      } catch (_) { resolve({success:false,code:'memory-unavailable'}); }
    }));
}

// Deliberately narrower than general maintenance: no unrestricted recursive deletion,
// no elevated cleanup, no documents/browser sessions/downloads.
// Safely targets user temp files, shader cache, and user crash dumps older than 24 hours.
const BOOST_SCRATCH_PATTERN = /^(rovarin|scoped_dir|npm-|pip-|yarn-|tmp|temp|\.tmp|wct|electron|node-|installer|cargo|rust|playwright|puppeteer)/i;

async function cleanScratchDirectoryTree(dirPath, cutoff, result, deadline, opsRef) {
  if (Date.now() > deadline || result.deletedCount >= 25000) { result.limited = true; return false; }
  try {
    const st = await fs.promises.lstat(dirPath);
    if (st.isSymbolicLink() || !st.isDirectory()) return false;
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    // Protect version control repositories and IDE workspaces from deletion
    if (entries.some(e => /^\.(git|svn|hg|vs|vscode)$/i.test(e.name))) {
      result.skippedCount += entries.length;
      return false;
    }
    let allCleaned = true;
    for (const ent of entries) {
      if (Date.now() > deadline || result.deletedCount >= 25000) { result.limited = true; return false; }
      if (++opsRef.count % 100 === 0) await new Promise(r => setImmediate(r));
      const childPath = path.join(dirPath, ent.name);
      try {
        const childSt = await fs.promises.lstat(childPath);
        if (childSt.isSymbolicLink() || childSt.nlink !== 1) {
          allCleaned = false;
          result.skippedCount++;
          continue;
        }
        if (childSt.isDirectory()) {
          const subOk = await cleanScratchDirectoryTree(childPath, cutoff, result, deadline, opsRef);
          if (!subOk) allCleaned = false;
        } else if (childSt.isFile()) {
          // Protect user documents and sensitive containers from deletion
          if (/\.(docx|xlsx|pptx|pdf|psd|ai|blend|epub|mobi|vhd|vhdx|kdbx)$/i.test(ent.name)) {
            result.skippedCount++;
            allCleaned = false;
            continue;
          }
          result.scannedCount++;
          if (childSt.mtimeMs > cutoff || (childSt.birthtimeMs && childSt.birthtimeMs > cutoff)) {
            result.skippedCount++;
            allCleaned = false;
            continue;
          }
          result.eligibleCount++;
          try {
            await fs.promises.unlink(childPath);
            result.bytesFreed += childSt.size;
            result.deletedCount++;
          } catch (e) {
            result.skippedCount++;
            allCleaned = false;
          }
        } else {
          allCleaned = false;
          result.skippedCount++;
        }
      } catch (_) {
        allCleaned = false;
        result.skippedCount++;
      }
    }
    if (allCleaned) {
      try {
        await fs.promises.rmdir(dirPath);
        result.deletedCount++;
        return true;
      } catch (_) {
        return false;
      }
    }
  } catch (_) {
    result.skippedCount++;
  }
  return false;
}

// Deliberately narrower than general maintenance: no unrestricted recursive deletion,
// no elevated cleanup, no documents/browser sessions/downloads.
// Safely targets user temp files, shader cache, and user crash dumps.
async function cleanBoostTargetDirectory(root, cutoff, result, deadline, allowedPattern = /\.(tmp|temp)$/i, options = {}) {
  const entries = await fs.promises.opendir(root);
  let staging;
  let sequence = 0;
  const opsRef = { count: 0 };
  try {
    for await (const entry of entries) {
      if (Date.now() > deadline || result.deletedCount >= 25000) { result.limited = true; break; }
      if (++opsRef.count % 100 === 0) await new Promise(r => setImmediate(r));
      result.scannedCount++;
      const file = path.join(root, entry.name);
      try {
        const before = await fs.promises.lstat(file);
        if (before.isSymbolicLink() || before.nlink !== 1) { result.skippedCount++; continue; }
        if (before.isFile()) {
          if (!allowedPattern.test(entry.name)) { result.skippedCount++; continue; }
          if (before.mtimeMs > cutoff || (before.birthtimeMs && before.birthtimeMs > cutoff)) { result.skippedCount++; continue; }
          result.eligibleCount++;
          if (!staging) staging = await fs.promises.mkdtemp(path.join(root, 'rovarin-boost-recovery-'));
          const captured = path.join(staging, String(sequence++) + '.tmp');
          await fs.promises.rename(file, captured);
          const current = await fs.promises.lstat(captured);
          if (!current.isFile() || current.nlink !== 1 || current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size || current.mtimeMs !== before.mtimeMs) {
            result.skippedCount++; result.failedCount++;
            if (current.isFile() && !current.isSymbolicLink()) {
              try { await fs.promises.link(captured, file); await fs.promises.unlink(captured); } catch (_) {}
            }
            continue;
          }
          await fs.promises.unlink(captured);
          result.bytesFreed += before.size; result.deletedCount++;
        } else if (before.isDirectory() && options.allowScratchDirs === true) {
          // Never delete recovery directories created by previous staging
          if (/^rovarin-boost-recovery-/i.test(entry.name)) {
            result.skippedCount++; continue;
          }
          if (!BOOST_SCRATCH_PATTERN.test(entry.name)) {
            result.skippedCount++; continue;
          }
          if (before.mtimeMs > cutoff || (before.birthtimeMs && before.birthtimeMs > cutoff)) { result.skippedCount++; continue; }
          await cleanScratchDirectoryTree(file, cutoff, result, deadline, opsRef);
        } else {
          result.skippedCount++;
        }
      } catch (_) { result.skippedCount++; result.failedCount++; }
    }
  } finally {
    if (staging) { try { await fs.promises.rmdir(staging); } catch (_) { result.recoveryRetained = true; } }
  }
}

async function cleanBoostTemp(directory = null, now = Date.now(), options = {}) {
  const retentionMs = options.retentionMs ?? (directory ? 24 * 60 * 60 * 1000 : 2 * 60 * 60 * 1000);
  const cutoff = now - retentionMs;
  const deadline = Date.now() + (options.timeoutMs ?? (directory ? 10000 : 25000));
  const result = {
    bytesFreed: 0,
    deletedCount: 0,
    scannedCount: 0,
    eligibleCount: 0,
    skippedCount: 0,
    failedCount: 0,
    limited: false,
    recoveryRetained: false,
    categories: {
      userTemp: { scanned: 0, deleted: 0, bytesFreed: 0, skipped: 0 },
      shaderCache: { scanned: 0, deleted: 0, bytesFreed: 0, skipped: 0 },
      crashReports: { scanned: 0, deleted: 0, bytesFreed: 0, skipped: 0 },
      inetCache: { scanned: 0, deleted: 0, bytesFreed: 0, skipped: 0 },
      windowsTemp: { scanned: 0, deleted: 0, bytesFreed: 0, skipped: 0 }
    }
  };

  if (directory) {
    const root = await fs.promises.realpath(directory);
    if (path.resolve(directory) !== root || !(await fs.promises.lstat(root)).isDirectory()) throw Error('Unsafe temp root');
    await cleanBoostTargetDirectory(root, cutoff, result, deadline, /\.(tmp|temp)$/i, { allowScratchDirs: options.allowScratchDirs || false });
    return result;
  }

  const targets = [];
  const realTemp = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp') : os.tmpdir();
  targets.push({ dir: realTemp, pattern: /\.(tmp|temp|log|dmp|bak|old|chk|prx)$/i, category: 'userTemp', allowScratchDirs: true });

  if (path.resolve(os.tmpdir()) !== path.resolve(realTemp)) {
    targets.push({ dir: os.tmpdir(), pattern: /\.(tmp|temp)$/i, category: 'userTemp', allowScratchDirs: false });
  }

  if (process.env.LOCALAPPDATA) {
    targets.push({
      dir: path.join(process.env.LOCALAPPDATA, 'D3DSCache'),
      pattern: /\.(bin|toc|lock)$/i,
      category: 'shaderCache',
      allowScratchDirs: false
    });
    targets.push({
      dir: path.join(process.env.LOCALAPPDATA, 'CrashDumps'),
      pattern: /\.dmp$/i,
      category: 'crashReports',
      allowScratchDirs: false
    });
    targets.push({
      dir: path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'WER', 'ReportArchive'),
      pattern: /.*/,
      category: 'crashReports',
      allowScratchDirs: false
    });
    targets.push({
      dir: path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'WER', 'ReportQueue'),
      pattern: /.*/,
      category: 'crashReports',
      allowScratchDirs: false
    });
    targets.push({
      dir: path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'INetCache'),
      pattern: /.*/,
      category: 'inetCache',
      allowScratchDirs: false
    });
  }

  const winTemp = path.join(process.env.SystemRoot || 'C:\\Windows', 'Temp');
  targets.push({
    dir: winTemp,
    pattern: /\.(tmp|temp|log|dmp|bak)$/i,
    category: 'windowsTemp',
    allowScratchDirs: false
  });

  for (const t of targets) {
    try {
      if (!fs.existsSync(t.dir)) continue;
      const root = await fs.promises.realpath(t.dir);
      if (path.resolve(t.dir) !== root || !(await fs.promises.lstat(root)).isDirectory()) continue;
      const beforeDeleted = result.deletedCount;
      const beforeBytes = result.bytesFreed;
      const beforeScanned = result.scannedCount;
      const beforeSkipped = result.skippedCount;
      await cleanBoostTargetDirectory(root, cutoff, result, deadline, t.pattern, { allowScratchDirs: t.allowScratchDirs });
      if (result.categories[t.category]) {
        result.categories[t.category].scanned += (result.scannedCount - beforeScanned);
        result.categories[t.category].deleted += (result.deletedCount - beforeDeleted);
        result.categories[t.category].bytesFreed += (result.bytesFreed - beforeBytes);
        result.categories[t.category].skipped += (result.skippedCount - beforeSkipped);
      }
    } catch (_) {}
  }

  return result;
}

function formatBoostBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function createBoostPressurePolicy() {
  let since=null,latched=false,lastBoost=-Infinity,lastSample=-Infinity;
  return {
    sample(total,available,now=Date.now()) {
      if(now-lastSample>15000||now<lastSample){since=null;latched=false;}
      lastSample=now;
      if(!Number.isFinite(total)||total<=0||!Number.isFinite(available)||available<0||available>total){since=null;latched=false;return false;}
      const low=available<=Math.min(total*.12,2*1073741824);
      const recovered=available>=Math.min(total*.20,3*1073741824);
      if(recovered){latched=false;since=null;}
      else if(low&&!latched){latched=true;since=now;}
      return latched&&since!==null&&now-since>=45000&&now-lastBoost>=600000;
    },
    completed(now=Date.now()){lastBoost=now;since=null;latched=false;}
  };
}
const boostPressure=createBoostPressurePolicy();
let boostProbe=null,boostProbeAt=-Infinity,boostProbePending=false;
function boostAdvice() {
  const now=Date.now();
  const sustained=boostPressure.sample(os.totalmem(),os.freemem(),now);
  if(sustained&&!isRunning&&!boostProbePending&&now-boostProbeAt>=60000){
    boostProbeAt=now;boostProbePending=true;
    trimBackgroundMemory(true).then(value=>{boostProbe=value;}).catch(()=>{boostProbe=null;}).finally(()=>{boostProbePending=false;});
  }
  const fresh=now-boostProbeAt<60000&&!boostProbePending;
  const suggested=Boolean(sustained&&fresh&&boostProbe?.success&&boostProbe.eligible>0&&boostProbe.eligibleWorkingSetBytes>=256*1048576);
  return {suggested,reason:suggested?'sustained-memory-pressure':'not-recommended',sampledAt:now};
}

async function executeBoost(task, finish) {
  if (process.platform !== 'win32') return finish(false,'Boost is available on Windows only.',{code:'unsupported'});
  task.totalSteps=2;
  task.stepTitle='Cleaning temporary files…';
  let disk;
  try {
    disk=await cleanBoostTemp();
  }
  catch (_) { return finish(false,'Temporary folder could not be verified; Boost stopped.',{code:'scan-unavailable'}); }
  task.currentStep=2; task.stepTitle='Reclaiming background-app memory…';
  const freeBefore = typeof os.freemem === 'function' ? os.freemem() : 0;
  const memory = await trimBackgroundMemory();
  boostPressure.completed();
  const freeAfter = typeof os.freemem === 'function' ? os.freemem() : freeBefore;
  const workingSetBytes = (Number.isSafeInteger(memory.workingSetReducedBytes) && (memory.trimmed || 0) > 0)
    ? Math.max(0, memory.workingSetReducedBytes)
    : 0;
  const availableChangeBytes=freeAfter-freeBefore;
  const availGainedBytes = Math.max(0,availableChangeBytes);
  const ramFreedBytes = workingSetBytes;
  const tempFreedBytes = disk.bytesFreed || 0;
  const wsLabel = formatBoostBytes(workingSetBytes);
  const availLabel = formatBoostBytes(availGainedBytes);
  const tempLabel = formatBoostBytes(tempFreedBytes);
  const partial = Boolean(disk.recoveryRetained || (disk.failedCount > 0 && disk.deletedCount === 0));
  const success = !disk.recoveryRetained;
  const scanned = disk.scannedCount || 0;
  const deleted = disk.deletedCount || 0;
  const skipped = disk.skippedCount || 0;
  const failed = disk.failedCount || 0;
  const trimmed = memory.trimmed || 0;
  const isNoOp = !partial && workingSetBytes === 0 && tempFreedBytes === 0 && trimmed === 0;
  const availSign = availableChangeBytes < 0 ? '-' : '+';
  const availDiff = formatBoostBytes(Math.abs(availableChangeBytes));

  let summary;
  if (isNoOp) {
    summary = `No Optimization Needed. Inspected ${scanned} items across temporary files and caches; evaluated background processes (none eligible for trimming or cache cleanup).`;
  } else {
    const parts = [];
    if (tempFreedBytes > 0 || deleted > 0) {
      parts.push(`Temporary files removed: ${tempLabel} (${deleted} items)`);
    } else {
      parts.push(`Temporary files: 0 MB freed (${scanned} scanned)`);
    }
    if (workingSetBytes > 0 || trimmed > 0) {
      parts.push(`Working-set reduction: ${wsLabel} across ${trimmed} background apps`);
    } else {
      parts.push(`Memory: 0 MB trimmed`);
    }
    parts.push(`System available RAM: ${availSign}${availDiff} observed`);
    if (skipped > 0 || failed > 0) {
      parts.push(`(${skipped} skipped, ${failed} failed)`);
    }
    summary = parts.join('. ') + '.';
  }
  appendLog(task,summary,partial?'warn':'info');
  finish(success,summary,{
    code:disk.recoveryRetained?'partially-completed':(isNoOp?'no-eligible-items':'boosted'),
    ...disk,
    bytesFreed:tempFreedBytes,
    tempFreedBytes,
    reclaimedBytes: tempFreedBytes,
    ramFreedBytes,
    workingSetTrimmedBytes: workingSetBytes,
    workingSetReductionBytes: workingSetBytes,
    workingSetReducedBytes: workingSetBytes,
    availableGainedBytes: availGainedBytes,
    availableChangeBytes,
    availableBeforeBytes: freeBefore,
    availableAfterBytes: freeAfter,
    trimmedProcesses: trimmed,
    memory
  });
}

// 1. Clean Temporary Files
async function executeCleanTemp(task, finish) {
  task.stepTitle = "Scanning and cleaning user temp files...";
  appendLog(task, "Locating temporary files folder...");

  const tempDirs = [os.tmpdir()];
  const winTemp = path.join(process.env.SystemRoot || 'C:\\Windows', 'Temp');
  try { await fs.promises.access(winTemp); tempDirs.push(winTemp); } catch (_) {}

  let totalDeleted = 0;
  let totalBytes = 0;
  let totalSkipped = 0;
  let scannedDirs = 0;

  for (const tDir of tempDirs) {
    appendLog(task, `Scanning directory: ${tDir}...`);
    try {
      const items = await fs.promises.readdir(tDir);
      scannedDirs++;
      for (const item of items) {
        const fullPath = path.join(tDir, item);
        try {
          const stats = await fs.promises.lstat(fullPath);
          // Never follow symlinks or junctions found inside a temp directory.
          if (stats.isSymbolicLink()) {
            totalSkipped++;
            continue;
          }
          if (stats.isFile()) {
            const size = stats.size;
            await fs.promises.unlink(fullPath);
            totalDeleted++;
            totalBytes += size;
          } else if (stats.isDirectory()) {
            await fs.promises.rm(fullPath, { recursive: true, force: true });
            totalDeleted++;
          }
        } catch (e) {
          // File currently open or locked by a running process
          totalSkipped++;
        }
      }
    } catch (e) {
      appendLog(task, `Note: Could not scan ${tDir} (${e.message})`, 'info');
    }
  }

  const mbFreed = (totalBytes / (1024 * 1024)).toFixed(1);
  if (!scannedDirs) return finish(false, 'Temporary folders could not be read; no cleanup was performed.', {code:'scan-unavailable',deletedCount:0,bytesFreed:0,skippedCount:totalSkipped});

  if (totalDeleted === 0 && totalSkipped === 0) {
    const summary = 'Temporary folders were already clean; nothing needed to be removed.';
    return finish(true, summary, { code: 'already-clean', deletedCount: 0, bytesFreed: 0, skippedCount: 0 });
  }

  if (totalDeleted === 0 && totalSkipped > 0) {
    const summary = `No temporary files could be removed (${totalSkipped} locked/in-use ${totalSkipped === 1 ? 'file' : 'files'} safely skipped).`;
    return finish(false, summary, { code: 'locked-files-only', deletedCount: 0, bytesFreed: 0, skippedCount: totalSkipped });
  }

  const summary = `Cleaned ${totalDeleted} temporary ${totalDeleted === 1 ? 'item' : 'items'} freeing ${mbFreed} MB${totalSkipped > 0 ? ` (${totalSkipped} locked/in-use ${totalSkipped === 1 ? 'file' : 'files'} safely skipped)` : ''}.`;
  finish(true, summary, { code: 'cleaned', deletedCount: totalDeleted, bytesFreed: totalBytes, skippedCount: totalSkipped });
}

// 2. Empty Recycle Bin
function executeEmptyRecycleBin(task, finish) {
  task.stepTitle = "Emptying Recycle Bin...";
  appendLog(task, "Executing Windows Recycle Bin purge...");

  execFile('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'scripts','empty-recycle-bin.ps1')],
    { windowsHide:true, timeout:30000, maxBuffer:64*1024 }, (err, stdout) => {
      let result;
      try {result=JSON.parse((stdout || '').trim());} catch (_) {}
      const summaries = {
        'already-empty':'Recycle Bin was already empty (verified).',
        'emptied':'Recycle Bin emptied successfully and verified.',
        'verification-unavailable':'Recycle Bin clear command completed, but verification is unavailable. Check the Windows Recycle Bin.',
        'items-remain':'Recycle Bin was not confirmed empty: items still remain after bounded verification.',
        'permission-denied':'Permission denied while clearing the current user Recycle Bin.',
        'tool-unavailable':'Windows Recycle Bin mechanism is unavailable.',
        'clear-failed':'Windows could not clear the Recycle Bin.'
      };
      if (!result || typeof result.success !== 'boolean' || !Object.hasOwn(summaries,result.code)) {
        result={success:false,code:err?.killed || err?.code==='ETIMEDOUT'?'timeout':err?.code==='ENOENT'?'tool-unavailable':['EACCES','EPERM'].includes(err?.code)?'permission-denied':'invalid-output'};
      }
      if (result.success !== ['already-empty','emptied','verification-unavailable'].includes(result.code)) result={success:false,code:'invalid-output'};
      if (err && result.success) result={success:false,code:err.killed?'timeout':'clear-failed'};
      const summary=summaries[result.code] || (result.code==='timeout'?'Recycle Bin operation timed out.':'Recycle Bin returned an invalid result; its state could not be confirmed.');
      finish(result.success,summary,result);
    });
}
// 3. Clear DNS Cache
function executeClearDns(task, finish) {
  task.stepTitle = "Flushing DNS resolver cache...";
  appendLog(task, "Running ipconfig /flushdns...");

  execFile('ipconfig', ['/flushdns'], { windowsHide: true, timeout: 10000 }, (err, stdout, stderr) => {
    if (err) {
      finish(false, `Failed to flush DNS cache: ${stderr || err.message}`);
    } else {
      const outputLines = (stdout || '').split(/\r?\n/).filter(Boolean);
      const cleanSummary = outputLines.find(l => l.includes('Successfully')) || "Windows DNS Resolver Cache flushed successfully.";
      finish(true, cleanSummary);
    }
  });
}

// Helper: Run command with live output streaming
function runLiveProcess(cmd, args, task, onOutput, onExit, timeoutMs = 30 * 60 * 1000) {
  appendLog(task, `Executing: ${cmd} ${args.join(' ')}`);
  let proc;
  try { proc = spawn(cmd, args, { windowsHide: true }); }
  catch (error) { onExit(-1, error); return; }
  let settled = false;
  const timeout = setTimeout(() => {
    try { proc.kill(); } catch (_) {}
    complete(-1, new Error('Command timed out.'));
  }, timeoutMs);
  const complete = (code, err) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    onExit(code, err);
  };

  proc.stdout.on('data', (data) => {
    const text = data.toString();
    const lines = text.split(/\r\n|\n|\r/).filter(Boolean);
    for (const line of lines) {
      if (line.trim()) onOutput(line.trim().slice(0,2000));
    }
  });

  proc.stderr.on('data', (data) => {
    const text = data.toString();
    const lines = text.split(/\r\n|\n|\r/).filter(Boolean);
    for (const line of lines) {
      if (line.trim()) appendLog(task, line.trim(), 'warn');
    }
  });

  proc.on('close', (code) => {
    complete(code);
  });

  proc.on('error', (err) => {
    appendLog(task, `Process error: ${err.message}`, 'error');
    complete(-1, err);
  });
}

function getSfcSummary(lines, code) {
  const text = lines.join(' ').toLowerCase();
  if (text.includes('did not find any integrity violations')) {
    return { success: code === 0, summary: 'Integrity check passed: no system file corruption found.' };
  }
  if (text.includes('successfully repaired them')) {
    return { success: code === 0, summary: 'Corrupt system files were detected and repaired.' };
  }
  if (text.includes('unable to fix some of them') || text.includes('found corrupt files but was unable to fix')) {
    return { success: false, summary: 'Corrupt files were found, but SFC could not repair all of them. See CBS.log for details.' };
  }
  if (code !== 0) return { success: false, summary: `SFC failed with exit code ${code}. Check CBS.log for details.` };
  return { success: true, summary: 'SFC scan completed successfully. Review the log for its detailed result.' };
}

// 4. Windows System Repair (DISM CheckHealth -> ScanHealth -> RestoreHealth -> SFC)
function executeWindowsRepair(task, finish, isAdmin) {
  if (!isAdmin) {
    appendLog(task, "Error: Windows System Repair (DISM and SFC) strictly requires Administrator elevation.", 'error');
    return finish(false, ADMIN_RELAUNCH_NOTE);
  }

  task.totalSteps = 4;
  task.currentStep = 1;
  task.stepTitle = "Step 1 of 4: Checking Component Store Health (DISM CheckHealth)...";
  appendLog(task, "Starting Step 1/4: DISM /CheckHealth");

  // Step 1: DISM CheckHealth
  runLiveProcess('dism', ['/online', '/cleanup-image', '/checkhealth'], task, 
    (line) => appendLog(task, line),
    (code1, error1) => {
      if (code1 !== 0) {
        return finish(false, `DISM CheckHealth failed (exit ${code1}${error1 ? `: ${error1.message}` : ''}). Review the maintenance log.`);
      }
      task.currentStep = 2;
      task.stepTitle = "Step 2 of 4: Scanning Component Store for Corruption (DISM ScanHealth)...";
      appendLog(task, "Starting Step 2/4: DISM /ScanHealth (this may take 2-5 minutes)...");

      // Step 2: DISM ScanHealth
      runLiveProcess('dism', ['/online', '/cleanup-image', '/scanhealth'], task,
        (line) => appendLog(task, line),
        (code2, error2) => {
          if (code2 !== 0) {
            return finish(false, `DISM ScanHealth failed (exit ${code2}${error2 ? `: ${error2.message}` : ''}). Review the maintenance log and DISM.log.`);
          }
          task.currentStep = 3;
          task.stepTitle = "Step 3 of 4: Restoring Component Store Image (DISM RestoreHealth)...";
          appendLog(task, "Starting Step 3/4: DISM /RestoreHealth...");

          // Step 3: DISM RestoreHealth
          runLiveProcess('dism', ['/online', '/cleanup-image', '/restorehealth'], task,
            (line) => appendLog(task, line),
            (code3, error3) => {
              if (code3 !== 0) {
                return finish(false, `DISM RestoreHealth failed (exit ${code3}${error3 ? `: ${error3.message}` : ''}). Review DISM.log; SFC was not started.`);
              }
              task.currentStep = 4;
              task.stepTitle = "Step 4 of 4: Scanning & Repairing System Files (SFC /scannow)...";
              appendLog(task, "Starting Step 4/4: SFC /scannow...");

              // Step 4: SFC /scannow
              let sfcOutput = [];
              runLiveProcess('sfc', ['/scannow'], task,
                (line) => {
                  sfcOutput.push(line);
                  if (sfcOutput.length > 1000) sfcOutput.shift();
                  appendLog(task, line);
                },
                (code4) => {
                  const sfcResult = getSfcSummary(sfcOutput, code4);
                  finish(sfcResult.success, `DISM repair steps completed. ${sfcResult.summary}`);
                }
              );
            }
          );
        }
      );
    }
  );
}

// 5. Scan Windows System Files (SFC only)
function executeSfcScan(task, finish, isAdmin) {
  if (!isAdmin) {
    appendLog(task, "Error: SFC requires Administrator privileges.", 'error');
    return finish(false, ADMIN_RELAUNCH_NOTE);
  }

  task.stepTitle = "Scanning Windows System Files with SFC (System File Checker)...";
  appendLog(task, "Beginning SFC system file verification scan...");

  let sfcOutput = [];
  runLiveProcess('sfc', ['/scannow'], task,
    (line) => {
      sfcOutput.push(line);
      if (sfcOutput.length > 1000) sfcOutput.shift();
      appendLog(task, line);
    },
    (code) => {
      const text = sfcOutput.join(' ');
      const result = getSfcSummary(sfcOutput, code);
      finish(result.success, result.summary);
    }
  );
}

// 6. Check Windows Component Store (DISM Diagnostic only)
function executeDismCheck(task, finish, isAdmin) {
  if (!isAdmin) {
    appendLog(task, "Error: DISM requires Administrator privileges.", 'error');
    return finish(false, ADMIN_RELAUNCH_NOTE);
  }

  task.totalSteps = 2;
  task.currentStep = 1;
  task.stepTitle = "Step 1 of 2: Quick Component Store Check (CheckHealth)...";
  appendLog(task, "Diagnostic Only: Checking if component store corruption has been flagged...");

  runLiveProcess('dism', ['/online', '/cleanup-image', '/checkhealth'], task,
    (line) => appendLog(task, line),
    (code1, error1) => {
      if (code1 !== 0) {
        return finish(false, `DISM CheckHealth failed (exit ${code1}${error1 ? `: ${error1.message}` : ''}). Review the maintenance log.`);
      }
      task.currentStep = 2;
      task.stepTitle = "Step 2 of 2: Deep Component Store Scan (ScanHealth)...";
      appendLog(task, "Scanning component store for corruption without modifying files...");

      let scanOutput = [];
      runLiveProcess('dism', ['/online', '/cleanup-image', '/scanhealth'], task,
        (line) => {
          scanOutput.push(line);
          if (scanOutput.length > 1000) scanOutput.shift();
          appendLog(task, line);
        },
        (code2, error2) => {
          const text = scanOutput.join(' ').toLowerCase();
          let summary = "Diagnostic complete.";
          let success = code2 === 0;
          if (code2 !== 0) {
            summary = `DISM ScanHealth failed (exit ${code2}${error2 ? `: ${error2.message}` : ''}). Review the log and DISM.log.`;
          } else if (text.includes("no component store corruption detected")) {
            summary = "Component Store is healthy: DISM reported no corruption.";
          } else if (text.includes("the component store is repairable")) {
            summary = "DISM found repairable component-store corruption. Run Windows System Repair with administrator approval.";
          } else if (text.includes("the component store cannot be repaired")) {
            summary = "DISM found component-store corruption that it cannot repair automatically. Review DISM.log.";
          } else {
            summary = "DISM CheckHealth and ScanHealth completed successfully (exit code 0). Review the log for the detailed health result.";
          }
          finish(success, summary, { checkHealthExitCode: code1, scanHealthExitCode: code2 });
        }
      );
    }
  );
}

// 7. Reset Network Settings
function executeResetNetwork(task, finish, isAdmin) {
  if (!isAdmin) {
    appendLog(task, "Error: Network reset requires Administrator privileges.", 'error');
    return finish(false, ADMIN_RELAUNCH_NOTE);
  }

  task.totalSteps = 2;
  task.currentStep = 1;
  task.stepTitle = "Step 1 of 2: Resetting Winsock Catalog...";
  appendLog(task, "Running: netsh winsock reset...");

  execFile('netsh', ['winsock', 'reset'], { windowsHide: true, timeout: 45000 }, (err1, out1) => {
    appendLog(task, (out1 || '').trim());
    if (err1) appendLog(task, `Winsock reset failed: ${err1.message}`, 'error');
    if (err1) return finish(false, `Winsock reset failed (exit ${err1.code ?? 'unknown'}): ${err1.message}`);

    task.currentStep = 2;
    task.stepTitle = "Step 2 of 2: Resetting TCP/IP Stack...";
    appendLog(task, "Running: netsh int ip reset...");

    execFile('netsh', ['int', 'ip', 'reset'], { windowsHide: true, timeout: 45000 }, (err2, out2) => {
      const text2 = (out2 || '').trim();
      appendLog(task, text2);
      const netshOk = (text2.includes(', OK!') || /successfully reset/i.test(text2) || /sucessfully reset/i.test(text2));
      const netshFail = (text2.includes(', failed.') || /access is denied/i.test(text2));
      const netshReboot = /restart the computer/i.test(text2);
      if (err2 || netshFail) {
        if (netshOk && netshReboot) {
          const summary = "Network reset partially completed (some protected system settings require restart). Restart your PC to finish applying it.";
          return finish(false, summary, { code: 'partially-completed', exitCode: err2?.code ?? 1 });
        }
        appendLog(task, `TCP/IP reset failed: ${err2?.message || 'Access denied'}`, 'error');
        return finish(false, `Winsock reset completed, but TCP/IP reset failed (exit ${err2?.code ?? 'unknown'}): ${err2?.message || 'Incomplete reset'}`, { code: 'operation-failed', exitCode: err2?.code ?? 1 });
      }
      const summary = "Winsock and TCP/IP stack have been reset to factory defaults. Please restart your PC to complete the reset.";
      finish(true, summary, { code: 'completed', exitCode: 0 });
    });
  });
}

// 8. Renew Network Connection
function executeRenewNetwork(task, finish) {
  task.stepTitle = "Refreshing DHCP IP leases...";
  appendLog(task, "Running ipconfig /renew (refreshing IP leases without dropping Tailscale)...");

  execFile('ipconfig', ['/renew'], { windowsHide: true, timeout: 90000 }, (err, stdout, stderr) => {
    if (err) {
      const reason = stderr || err.message;
      appendLog(task, `DHCP lease renewal failed: ${reason}`, 'error');
      return finish(false, `DHCP lease renewal failed (exit ${err.code ?? 'unknown'}): ${reason}`);
    }
    const lines = (stdout || '').split(/\r?\n/).filter(Boolean);
    for (const line of lines.slice(0, 10)) {
      appendLog(task, line);
    }
    finish(true, "DHCP lease renewal command completed successfully.");
  });
}

// 9. Restart Windows Explorer
function executeRestartExplorer(task, finish) {
  task.stepTitle = "Restarting Windows Explorer shell...";
  appendLog(task, "Stopping explorer.exe process...");

  execFile('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `$ErrorActionPreference='Stop'; $session=(Get-Process -Id $PID).SessionId; function Get-SessionExplorer { Get-Process explorer -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $session } }; Get-SessionExplorer | Stop-Process -Force -ErrorAction Stop; Start-Sleep -Milliseconds 800; if (-not (Get-SessionExplorer)) { Start-Process explorer }; Start-Sleep -Milliseconds 500; if (Get-SessionExplorer) { Write-Output 'EXPLORER_OK' } else { throw 'explorer.exe did not restart in this session' }`
  ], { windowsHide: true, timeout: 15000 }, (err, stdout, stderr) => {
    if (err || !(stdout || '').includes('EXPLORER_OK')) {
      const reason = err?.message || stderr || 'Explorer process did not return the success marker.';
      appendLog(task, `Explorer restart failed: ${reason}`, 'error');
      return finish(false, `Could not verify Windows Explorer restarted: ${reason}`);
    }
    finish(true, "Windows Explorer has been restarted successfully.");
  });
}

// Export module interface
module.exports = { boostAdvice, standbyBusy:()=>isRunning||boostProbePending,
  ACTIONS,
  runAction,
  setServiceClient: (client) => { serviceClient = client; },
  getStatus: (callback) => {
    checkIsAdmin((isAdmin) => {
      serviceClient.status().then(service => {
        callback({
          isAdmin,
          isRunning,
          service: { enabled: Boolean(service && service.enabled), state: service ? service.state : 'unavailable' },
          currentTask: currentTask ? {
            id: currentTask.id,
            title: currentTask.title,
            category: currentTask.category,
            status: currentTask.status,
            currentStep: currentTask.currentStep,
            totalSteps: currentTask.totalSteps,
            stepTitle: currentTask.stepTitle,
            logs: currentTask.logs,
            result: currentTask.result
          } : null,
          history
        });
      }).catch(() => {
        callback({
          isAdmin,
          isRunning,
          service: { enabled: false, state: 'unavailable' },
          currentTask: currentTask ? {
            id: currentTask.id,
            title: currentTask.title,
            category: currentTask.category,
            status: currentTask.status,
            currentStep: currentTask.currentStep,
            totalSteps: currentTask.totalSteps,
            stepTitle: currentTask.stepTitle,
            logs: currentTask.logs,
            result: currentTask.result
          } : null,
          history
        });
      });
    });
  }
};
