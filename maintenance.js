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
    if (detailedResult?.code === 'partially-completed') success = false;
    currentTask.status = detailedResult?.code === 'uac-cancelled'
      ? 'cancelled'
      : detailedResult?.code === 'partially-completed'
        ? 'partially-completed'
        : success ? 'completed' : 'failed';
    currentTask.result = { success, summary, detailedResult };
    appendLog(currentTask, summary, success ? 'success' : 'error');
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
      appendLog(task, `Note: Could not scan ${tDir} (${e.message})`, 'warn');
    }
  }

  const mbFreed = (totalBytes / (1024 * 1024)).toFixed(1);
  if (!scannedDirs) return finish(false, 'Temporary folders could not be read; no cleanup was performed.', {code:'scan-unavailable',deletedCount:0,bytesFreed:0,skippedCount:totalSkipped});
  const summary = `Successfully cleaned ${totalDeleted} temporary items freeing ${mbFreed} MB (${totalSkipped} locked/in-use files safely skipped).`;
  finish(true, summary, { deletedCount: totalDeleted, bytesFreed: totalBytes, skippedCount: totalSkipped });
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
module.exports = {
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
