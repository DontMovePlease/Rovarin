#define AppVersion "0.2.0"
[Setup]
AppId={{C51A4180-26D2-4F48-93BD-B40B182B78DA}
AppName=Rovarin
AppVersion={#AppVersion}
VersionInfoVersion={#AppVersion}.0
VersionInfoProductVersion={#AppVersion}.0
AppPublisher=Rovarin
Uninstallable=yes
CreateUninstallRegKey=yes
UninstallDisplayName=Rovarin
DefaultDirName={localappdata}\Rovarin
UsePreviousAppDir=no
UsePreviousGroup=no
DefaultGroupName=Rovarin
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.22000
OutputDir=..\dist
OutputBaseFilename=RovarinSetup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern dark polar includetitlebar
WizardSizePercent=110
LicenseFile=payload\app\LICENSE
UninstallDisplayIcon={app}\app\Rovarin.exe
SetupIconFile=payload\app\Rovarin.ico
CloseApplications=no
RestartApplications=no
SetupLogging=no

[Types]
Name: "full"; Description: "Rovarin with optional Enhanced CPU Temperature support"
Name: "custom"; Description: "Custom installation"; Flags: iscustom
[Components]
Name: "core"; Description: "Rovarin (self-contained Node runtime)"; Types: full custom; Flags: fixed
Name: "enhanced"; Description: "Enhanced CPU Temperature - Recommended (installs the signed PawnIO hardware-access driver; Windows UAC approval required)"; Types: full
[Tasks]
Name: "startup"; Description: "Start Rovarin with Windows (quietly at sign-in)"; Flags: checkedonce
Name: "desktopPin"; Description: "Require a PIN when opening Rovarin on this PC"; Flags: checkedonce; Check: FreshDesktopPreference
[Dirs]
Name: "{app}\data"
[Files]
Source: "payload\app\scripts\rebrand-migration.ps1"; Flags: dontcopy
Source: "payload\app\*"; DestDir: "{app}\app"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "payload\runtime\*"; DestDir: "{app}\runtime"; Flags: ignoreversion recursesubdirs createallsubdirs
[Icons]
Name: "{group}\Rovarin"; Filename: "{app}\app\Rovarin.exe"; WorkingDir: "{app}\app"; IconFilename: "{app}\app\Rovarin.exe"
Name: "{group}\Rovarin Setup and PIN Recovery"; Filename: "{app}\app\Rovarin.exe"; Parameters: "setup"; WorkingDir: "{app}\app"; IconFilename: "{app}\app\Rovarin.exe"
Name: "{group}\Disable Rovarin Startup"; Filename: "{app}\app\Rovarin.exe"; Parameters: "disable-startup"; WorkingDir: "{app}\app"
Name: "{group}\Uninstall Rovarin"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Rovarin"; Filename: "{app}\app\Rovarin.exe"; WorkingDir: "{app}\app"; IconFilename: "{app}\app\Rovarin.exe"
Name: "{userstartup}\Rovarin"; Filename: "{app}\app\Rovarin.exe"; Parameters: "startup"; WorkingDir: "{app}\app"; Tasks: startup
[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\app\scripts\install-enhanced.ps1"" -Notify"; Components: enhanced; Flags: runhidden waituntilterminated skipifsilent
Filename: "{app}\app\Rovarin.exe"; Description: "Launch Rovarin"; Flags: postinstall nowait skipifsilent
[InstallDelete]
Type: files; Name: "{group}\Rovarin Web Dashboard.lnk"
[Messages]
FinishedHeadingLabel=Rovarin installed successfully
FinishedLabel=Rovarin is ready on this PC. Launch it to finish Setup or open your dashboard. Tailscale is needed only to connect from another device.
[UninstallDelete]
Type: files; Name: "{app}\app\uninstall-trust.json"
Type: dirifempty; Name: "{app}\app"
[Code]
var FullRemoval, ExistingOnboarding, ExistingConfiguration: Boolean;
function RebrandMigration(Mode: String): Boolean;
var ExitCode: Integer;
begin
  ExtractTemporaryFile('rebrand-migration.ps1');
  Result := Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + ExpandConstant('{tmp}\rebrand-migration.ps1') + '" -Mode ' + Mode + ' -Destination "' + ExpandConstant('{app}') + '"',
    ExpandConstant('{tmp}'), SW_HIDE, ewWaitUntilTerminated, ExitCode) and (ExitCode = 0);
end;
function FreshDesktopPreference(): Boolean;
begin
  Result := not FileExists(ExpandConstant('{app}\data\config.json'));
end;
function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if (CurPageID = wpSelectTasks) and FreshDesktopPreference() and not WizardIsTaskSelected('desktopPin') then
    Result := MsgBox('Allow this Windows account to open the native Rovarin app without entering a PIN?' + #13#10 + #13#10 +
      'Anyone with access to this account may open Rovarin. Other devices and ordinary browsers will still require the same Rovarin PIN.', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES;
end;
function UninstallHelper(Mode: String; Extra: String): Boolean;
var ExitCode: Integer;
begin
  Result := Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\app\scripts\installed-uninstall.ps1') + '" -Mode ' + Mode + Extra,
    ExpandConstant('{tmp}'), SW_HIDE, ewWaitUntilTerminated, ExitCode) and (ExitCode = 0);
end;
function StopInstalledServer(): String;
var ExitCode: Integer; Helper, Desktop: String;
begin
  Result := '';
  Desktop := ExpandConstant('{app}\app\Rovarin.exe');
  if FileExists(Desktop) then begin
    if not Exec(Desktop, 'close-desktop', '', SW_HIDE, ewWaitUntilTerminated, ExitCode) then begin
      Result := 'Rovarin desktop could not close safely. Exit it from the tray before continuing.'; exit;
    end;
    { Previous fixed-mode launcher returns 2: it has no resident desktop shell. }
    if (ExitCode <> 0) and (ExitCode <> 2) then begin
      Result := 'Rovarin desktop is still open. Exit it from the tray before continuing.'; exit;
    end;
  end;
  Helper := ExpandConstant('{app}\app\scripts\stop.ps1');
  if not FileExists(Helper) then exit;
  if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + Helper + '"', '', SW_HIDE, ewWaitUntilTerminated, ExitCode) then
    Result := 'Rovarin could not be stopped safely. Close it before continuing.'
  else if ExitCode <> 0 then
    Result := 'Existing Rovarin ownership could not be confirmed. No process was stopped. Close Rovarin and try again.';
end;
function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  if not RebrandMigration('Prepare') then begin
    Result := 'Rovarin could not safely migrate the existing installation. Your PIN/settings were retained. No unrelated process was stopped.'; exit;
  end;
  ExistingOnboarding := FileExists(ExpandConstant('{app}\data\config.json')) and
    (FileExists(ExpandConstant('{app}\app\server.js')) or FileExists(ExpandConstant('{app}\data\rebrand-migration.json')));
  ExistingConfiguration := FileExists(ExpandConstant('{app}\data\config.json'));
  Result := StopInstalledServer();
end;
function InitializeUninstall(): Boolean;
var Problem: String; I: Integer;
begin
  Result := False;
  if not UninstallHelper('Validate', '') then begin
    SuppressibleMsgBox('Installation safety checks failed. No files were removed. Inspect the installation before trying again.', mbError, MB_OK, IDOK); exit;
  end;
  FullRemoval := False;
  for I := 1 to ParamCount do if Uppercase(ParamStr(I)) = '/FULLREMOVAL' then FullRemoval := True;
  if not UninstallSilent then
    FullRemoval := MsgBox('Full removal: also erase your Rovarin PIN, configuration and temperature preferences?' + #13#10 + #13#10 +
      'Choose No to preserve settings for reinstall (default). Shared PawnIO and Tailscale will remain installed.', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES;
  Problem := StopInstalledServer();
  Result := Problem = '';
  if not Result then SuppressibleMsgBox(Problem, mbError, MB_OK, IDOK);
end;
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var Extra: String;
begin
  if CurUninstallStep = usUninstall then begin
    Extra := ''; if FullRemoval then Extra := ' -FullRemoval';
    if not UninstallHelper('Cleanup', Extra) then
      RaiseException('Rovarin data cleanup could not be verified. Uninstall stopped; inspect the installation.');
  end;
end;
procedure CurStepChanged(CurStep: TSetupStep);
var Extra, Preference: String; ExitCode: Integer;
begin
  if CurStep = ssPostInstall then begin
    { Never overwrite an upgrade/preserved-data PIN or desktop preference. }
    if not ExistingConfiguration then begin
      Preference := '--desktop-pin-on';
      if not WizardIsTaskSelected('desktopPin') then begin
        if WizardSilent then RaiseException('Passwordless desktop requires interactive confirmation.');
        Preference := '--desktop-pin-off';
      end;
      if not Exec(ExpandConstant('{app}\runtime\node.exe'), '"' + ExpandConstant('{app}\app\pin-manager.js') + '" ' + Preference,
        ExpandConstant('{app}\app'), SW_HIDE, ewWaitUntilTerminated, ExitCode) or (ExitCode <> 0) then
        RaiseException('Could not save the desktop PIN preference. Installation needs repair.');
    end;
  end;
  if CurStep = ssDone then begin
    Extra := ''; if not WizardIsTaskSelected('startup') then Extra := ' -RemoveStartup';
    if not UninstallHelper('Register', Extra) then
      RaiseException('Could not register trusted Rovarin uninstall metadata. Installation needs repair.');
    { Existing users must not receive an automatic PIN reveal after upgrade. }
    if ExistingOnboarding and not FileExists(ExpandConstant('{app}\data\onboarding-complete.json')) then
      if not SaveStringToFile(ExpandConstant('{app}\data\onboarding-complete.json'), '{"completed":true}', False) then
        RaiseException('Could not preserve local Setup completion. Installation needs repair.');
    if not RebrandMigration('Commit') then
      RaiseException('Rovarin migration is not yet verified. Preserved settings remain available; retry installation before removing legacy data.');
  end;
end;
