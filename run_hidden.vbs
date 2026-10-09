' Windows VBScript to launch Rovarin Dashboard in the background with no console window
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = scriptDir
If fso.FileExists(fso.BuildPath(scriptDir, "installation.json")) Then
    ' Installed runtime never uses PATH/node/npm or shell redirection.
    psScript = fso.BuildPath(scriptDir, "scripts\installed-start.ps1")
    WshShell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & psScript & """", 0, False
Else
    psScript = fso.BuildPath(scriptDir, "scripts\development-start.ps1")
    WshShell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & psScript & """", 0, False
End If
