; Call Board one-click installer (per user, no admin needed)
Unicode true
!define APPNAME "Bullpen"
!define EXE "Bullpen.exe"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Bullpen"

Name "${APPNAME}"
!ifndef VERSION
  !define VERSION "dev"
!endif
OutFile "..\dist\Bullpen-Setup-${VERSION}.exe"
InstallDir "$LOCALAPPDATA\Programs\Bullpen"
RequestExecutionLevel user
Icon "icon.ico"
UninstallIcon "icon.ico"
SetCompressor /SOLID lzma
AutoCloseWindow true
ShowInstDetails nevershow
BrandingText "Highwater"

Page instfiles
UninstPage instfiles

Section "Install"
  ; close a running copy so files can be replaced
  nsExec::Exec 'taskkill /F /IM "${EXE}"'
  ; remove the old "Call Board" install (renamed to Bullpen); the API key carries over
  nsExec::Exec 'taskkill /F /IM "Call Board.exe"'
  Sleep 800
  RMDir /r "$LOCALAPPDATA\Programs\Call Board"
  Delete "$DESKTOP\Call Board.lnk"
  Delete "$SMPROGRAMS\Call Board.lnk"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CallBoard"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.wearehighwater.callboard"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Call Board"
  SetOutPath "$INSTDIR"
  File /r "..\dist\win-unpacked\*.*"
  File "icon.ico"
  WriteUninstaller "$INSTDIR\Uninstall Bullpen.exe"
  CreateShortcut "$DESKTOP\${APPNAME}.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\icon.ico"
  CreateShortcut "$SMPROGRAMS\${APPNAME}.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\icon.ico"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayName" "${APPNAME}"
  WriteRegStr HKCU "${UNINSTKEY}" "Publisher" "Highwater"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayIcon" "$INSTDIR\${EXE}"
  WriteRegStr HKCU "${UNINSTKEY}" "UninstallString" '"$INSTDIR\Uninstall Bullpen.exe"'
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoRepair" 1
  Exec '"$INSTDIR\${EXE}"'
SectionEnd

Section "Uninstall"
  nsExec::Exec 'taskkill /F /IM "${EXE}"'
  Sleep 800
  ; stop starting at login
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.wearehighwater.callboard"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Bullpen"
  Delete "$DESKTOP\${APPNAME}.lnk"
  Delete "$SMPROGRAMS\${APPNAME}.lnk"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${UNINSTKEY}"
SectionEnd
