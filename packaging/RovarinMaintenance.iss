#ifndef ServicePayload
#error ServicePayload is required
#endif
#ifndef ServiceHash
#error ServiceHash is required
#endif
#ifndef ProductVersion
#error ProductVersion is required
#endif
[Setup]
AppId={{29A7A2B3-25AE-4B38-AD10-520AA65684BB}
AppName=Rovarin Administrator Maintenance
AppVersion={#ProductVersion}
AppPublisher=Rovarin
DefaultDirName={autopf64}\RovarinMaintenance
UsePreviousAppDir=no
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.22000
OutputBaseFilename=RovarinMaintenanceSetup
UninstallDisplayName=Rovarin Administrator Maintenance
Uninstallable=yes
Compression=lzma2
SolidCompression=yes
CloseApplications=no
RestartApplications=no
SetupLogging=no
[Files]
Source: "{#ServicePayload}\RovarinMaintenanceService.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#ServicePayload}\RovarinMaintenanceService.exe.sha256"; DestDir: "{app}"; Flags: ignoreversion
[UninstallDelete]
Type: dirifempty; Name: "{app}"
[Code]
const ProtectedAcl = 'O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FRFX;;;BU)';
var RequestedOwner: String;
function ConvertStringSecurityDescriptorToSecurityDescriptor(Sddl: String; Revision: Cardinal; var Descriptor: NativeUInt; var Size: Cardinal): Boolean;
  external 'ConvertStringSecurityDescriptorToSecurityDescriptorW@advapi32.dll stdcall';
function ConvertSecurityDescriptorToStringSecurityDescriptor(Descriptor: NativeUInt; Revision, Information: Cardinal; var Text: NativeUInt; var Size: Cardinal): Boolean;
  external 'ConvertSecurityDescriptorToStringSecurityDescriptorW@advapi32.dll stdcall';
function GetNamedSecurityInfo(Path: String; ObjectType, Information: Cardinal; var Owner, Group, Dacl, Sacl, Descriptor: NativeUInt): Cardinal;
  external 'GetNamedSecurityInfoW@advapi32.dll stdcall';
function SetFileSecurity(Path: String; Information: Cardinal; Descriptor: NativeUInt): Boolean;
  external 'SetFileSecurityW@advapi32.dll stdcall';
function LocalFree(Value: NativeUInt): NativeUInt;
  external 'LocalFree@kernel32.dll stdcall';
function StringLength(Value: NativeUInt): Integer;
  external 'lstrlenW@kernel32.dll stdcall';
function CopyString(Destination: String; Source: NativeUInt; Count: Integer): NativeUInt;
  external 'lstrcpynW@kernel32.dll stdcall';
function GetFileAttributes(Path: String): Cardinal;
  external 'GetFileAttributesW@kernel32.dll stdcall';
function SecurityText(Path: String): String;
var Owner, Group, Dacl, Sacl, Descriptor, Text: NativeUInt; Size: Cardinal; Count: Integer;
begin
  Result := ''; Descriptor := 0; Text := 0;
  if GetNamedSecurityInfo(Path, 1, 5, Owner, Group, Dacl, Sacl, Descriptor) <> 0 then exit;
  try
    if not ConvertSecurityDescriptorToStringSecurityDescriptor(Descriptor, 1, 5, Text, Size) then exit;
    try
      Count := StringLength(Text); if (Count < 1) or (Count > 16384) then exit;
      SetLength(Result, Count + 1); CopyString(Result, Text, Count + 1); SetLength(Result, Count);
    finally LocalFree(Text); end;
  finally LocalFree(Descriptor); end;
end;
function Field(Value: String; Index: Integer): String;
var I, P: Integer;
begin
  for I := 1 to Index do begin P := Pos(';', Value); if P = 0 then begin Result := ''; exit; end; Delete(Value, 1, P); end;
  P := Pos(';', Value); if P = 0 then Result := Value else Result := Copy(Value, 1, P - 1);
end;
function SafeUnprivilegedRights(Rights: String; Ancestor: Boolean): Boolean;
var Mask: Cardinal;
begin
  { Windows serializes the drive root's create-subdirectory bit (0x4) as LC.
    Creating another child cannot replace an existing protected ancestor.
    This permission is allowed only on ancestors, never service files/directories. }
  if Ancestor and (Rights = 'LC') then begin Result := True; exit; end;
  if Ancestor and (Copy(Rights, 1, 2) = '0x') then begin
    Mask := StrToInt('$' + Copy(Rights, 3, Length(Rights)));
    Result := (Mask and $500D0040) = 0; exit;
  end;
  Result := (Rights = 'FRFX') or (Rights = 'FR') or (Rights = 'FX') or
    (Rights = 'GRGX') or (Rights = 'GR') or (Rights = 'GX') or
    (Rights = '0x1200a9') or (Rights = '0x120089');
end;
function RightsPolicySelfTest(): Boolean;
begin
  Result := SafeUnprivilegedRights('LC', True) and
    not SafeUnprivilegedRights('LC', False) and
    not SafeUnprivilegedRights('FA', True) and
    not SafeUnprivilegedRights('WD', True) and
    not SafeUnprivilegedRights('WO', True) and
    not SafeUnprivilegedRights('0x40000000', True) and
    not SafeUnprivilegedRights('0x40', True) and
    not SafeUnprivilegedRights('0x10000', True) and
    SafeUnprivilegedRights('0x4', True) and
    not SafeUnprivilegedRights('unknown', True);
end;
function SafeExistingMode(Path: String; Ancestor: Boolean): Boolean;
var Text, Ace, Sid, Rights: String; First, Last: Integer; Attributes, Mask: Cardinal;
begin
  Result := False; Attributes := GetFileAttributes(Path);
  if (Attributes = $FFFFFFFF) or ((Attributes and $400) <> 0) then exit;
  Text := SecurityText(Path);
  if (Pos('O:BA', Text) <> 1) and (Pos('O:SY', Text) <> 1) and (Pos('O:S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464', Text) <> 1) then exit;
  if Pos('D:', Text) = 0 then exit;
  First := Pos('(', Text); if First = 0 then exit;
  while First > 0 do begin
    Delete(Text, 1, First); Last := Pos(')', Text); if Last = 0 then exit;
    Ace := Copy(Text, 1, Last - 1); Sid := Field(Ace, 5); Rights := Field(Ace, 2);
    if Copy(Ace, 1, 2) = 'A;' then begin
      if (Sid <> 'BA') and (Sid <> 'SY') and (Sid <> 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464') then begin
        if Ancestor and (Pos('IO', Field(Ace, 1)) > 0) then begin end
        else if not SafeUnprivilegedRights(Rights, Ancestor) then exit;
      end;
    end else if Copy(Ace, 1, 2) <> 'D;' then exit;
    Delete(Text, 1, Last); First := Pos('(', Text);
  end;
  Result := True;
end;
function SafeExisting(Path: String): Boolean;
begin Result := SafeExistingMode(Path, False); end;
function SafeAncestors(): Boolean;
var Path, Parent: String;
begin
  Result := False; Path := ExpandConstant('{autopf64}');
  while True do begin
    if not SafeExistingMode(Path, True) then exit;
    Parent := ExtractFileDir(Path); if (Parent = Path) or (Length(Path) <= 3) then break;
    Path := Parent;
  end;
  Result := True;
end;
procedure Protect(Path: String);
var Descriptor: NativeUInt; Size: Cardinal;
begin
  Descriptor := 0;
  if not ConvertStringSecurityDescriptorToSecurityDescriptor(ProtectedAcl, 1, Descriptor, Size) then RaiseException('Could not establish protected permissions.');
  try
    if not SetFileSecurity(Path, $80000005, Descriptor) then RaiseException('Could not protect the maintenance installation.');
  finally LocalFree(Descriptor); end;
  if not SafeExisting(Path) then RaiseException('Protected permissions could not be verified.');
end;
function ValidOwner(Value: String): Boolean;
var I, Groups: Integer;
begin
  Result := False; if Copy(Value, 1, 9) <> 'S-1-5-21-' then exit;
  Groups := 0;
  for I := 10 to Length(Value) do begin
    if Value[I] = '-' then Groups := Groups + 1 else if (Value[I] < '0') or (Value[I] > '9') then exit;
  end;
  Result := (Groups = 3) and (Length(Value) < 80);
end;
function InitializeSetup(): Boolean;
begin
  RequestedOwner := ExpandConstant('{param:OWNER|}');
  Result := RightsPolicySelfTest() and ValidOwner(RequestedOwner) and not WizardSilent;
  if not Result then MsgBox('Start this local installer from the intended Rovarin account with its OWNER SID. Interactive Windows approval is required. No service was enabled.', mbError, MB_OK);
end;
function Helper(Arguments: String): Boolean;
var ExitCode: Integer; Image, DigestPath: String; Digest: AnsiString;
begin
  Image := ExpandConstant('{app}\RovarinMaintenanceService.exe');
  Result := False; DigestPath := Image + '.sha256';
  if not SafeAncestors() or not SafeExisting(ExpandConstant('{app}')) or not SafeExisting(Image) or not SafeExisting(DigestPath) then exit;
  if not LoadStringFromFile(DigestPath, Digest) then exit;
  if CompareText(GetSHA256OfFile(Image), Trim(String(Digest))) <> 0 then exit;
  Result := Exec(Image, Arguments, ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ExitCode) and (ExitCode = 0);
end;
function PrepareToInstall(var NeedsRestart: Boolean): String;
var Image: String;
begin
  Result := '';
  if CompareText(ExpandConstant('{app}'), ExpandConstant('{autopf64}\RovarinMaintenance')) <> 0 then begin Result := 'Unsafe maintenance installation path.'; exit; end;
  if not SafeAncestors() then begin Result := 'Unsafe ancestor of the protected service directory.'; exit; end;
  Image := ExpandConstant('{app}\RovarinMaintenanceService.exe');
  if DirExists(ExpandConstant('{app}')) then begin
    if not SafeExisting(ExpandConstant('{app}')) then begin Result := 'Existing maintenance directory is not protected. Nothing was executed.'; exit; end;
    if FileExists(Image) then
      if not Helper('--prepare-package-update') then begin Result := 'Existing maintenance service could not be safely revoked and stopped.'; exit; end;
  end else begin
    if not ForceDirectories(ExpandConstant('{app}')) then begin Result := 'Could not create protected maintenance directory.'; exit; end;
    Protect(ExpandConstant('{app}'));
  end;
end;
procedure CurStepChanged(Step: TSetupStep);
begin
  if Step = ssPostInstall then begin
    Protect(ExpandConstant('{app}\RovarinMaintenanceService.exe'));
    Protect(ExpandConstant('{app}\RovarinMaintenanceService.exe.sha256'));
    if CompareText(GetSHA256OfFile(ExpandConstant('{app}\RovarinMaintenanceService.exe')), '{#ServiceHash}') <> 0 then RaiseException('Packaged service integrity check failed. Service was not provisioned.');
    if not Helper('--provision ' + RequestedOwner) then RaiseException('Maintenance provisioning failed safely. Access remains revoked; retry local installation.');
  end;
  if Step = ssDone then begin
    Protect(ExpandConstant('{uninstallexe}'));
    Protect(ChangeFileExt(ExpandConstant('{uninstallexe}'), '.dat'));
  end;
end;
function InitializeUninstall(): Boolean;
begin
  Result := Helper('--prepare-package-update');
  if not Result then MsgBox('Maintenance access could not be safely revoked and stopped. No service files were removed.', mbError, MB_OK);
end;
