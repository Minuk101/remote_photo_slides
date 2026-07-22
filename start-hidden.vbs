Set shell = CreateObject("WScript.Shell")
scriptDirectory = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
shell.Run Chr(34) & scriptDirectory & "\start.bat" & Chr(34), 0, False

