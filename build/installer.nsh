; Runs inside the electron-builder installer. Clears out the old hand-built "Call Board" / "Bullpen" installs.
!macro customInit
  nsExec::Exec 'taskkill /F /IM "Bullpen.exe"'
  nsExec::Exec 'taskkill /F /IM "Call Board.exe"'
  Sleep 600
  RMDir /r "$LOCALAPPDATA\Programs\Call Board"
  Delete "$DESKTOP\Call Board.lnk"
  Delete "$SMPROGRAMS\Call Board.lnk"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CallBoard"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Bullpen"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Call Board"
!macroend
