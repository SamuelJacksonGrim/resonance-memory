' Resonance Memory - double-click to open the control panel.
' Runs with NO console window. The panel opens in your browser;
' closing that tab shuts the background process down on its own.
Set fso = CreateObject("Scripting.FileSystemObject")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = appDir
sh.Run """" & appDir & "\resonance-memory.exe""", 0, False
