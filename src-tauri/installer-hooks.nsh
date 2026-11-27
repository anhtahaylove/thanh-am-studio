; Files that earlier versions installed and later versions no longer ship: Intel's OpenMP stub library (Intel EULA), NVIDIA
; cuDNN, and (since the separation runtime became a download) PyTorch, Demucs and their helpers. The updater installs over
; the old version without uninstalling it, so they would otherwise stay behind.
; Removes site-packages\<package> and site-packages\<package>-*.dist-info, only inside an installation of this app
; (its private python.exe is there) and only with a non-empty $INSTDIR.
!macro ThanhAmRemovePackage package
  Push $R0
  Push $R1
  ${If} $INSTDIR != ""
  ${AndIf} ${FileExists} "$INSTDIR\runtime\python\python.exe"
    RMDir /r "$INSTDIR\runtime\python\Lib\site-packages\${package}"
    FindFirst $R0 $R1 "$INSTDIR\runtime\python\Lib\site-packages\${package}-*.dist-info"
    ${While} $R1 != ""
      RMDir /r "$INSTDIR\runtime\python\Lib\site-packages\$R1"
      FindNext $R0 $R1
    ${EndWhile}
    FindClose $R0
  ${EndIf}
  Pop $R1
  Pop $R0
!macroend

; Up to 1.0.25 the productName was THANHAM_OLD (A with circumflex, precomposed U+00C2). It named the install folder, the
; uninstall entry, the location key and the shortcuts. The hooks below move such an install to the ASCII name: an old install
; in a folder the user chose is updated in place, the old default folder loses only what this app put there, and the old keys
; and shortcuts go once that install is gone or reused. They are macros, not Functions, because the uninstall section cannot
; call installer Functions. Every hook leaves $0-$9 and $R0-$R9 as it found them (System::Store).
!define THANHAM_OLD "Thanh ${U+00C2}m Studio"
!define THANHAM_OLDDIR "$LOCALAPPDATA\${THANHAM_OLD}"
!define THANHAM_OLDKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${THANHAM_OLD}"
!define THANHAM_PIN "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\${THANHAM_OLD}.lnk"
Var ThanhAmOldDir
Var ThanhAmOwned

; result = 1 when $INSTDIR is dir or lies inside it. `==` ignores case, so dir in another case still counts; the trailing
; backslashes keep a sibling with a longer name (dir2) outside.
!macro ThanhAmInside result dir
  StrLen $R8 "${dir}\"
  StrCpy $R9 "$INSTDIR\" $R8
  StrCpy ${result} 0
  ${If} $R9 == "${dir}\"
    StrCpy ${result} 1
  ${EndIf}
!macroend

; The folder of an install of the old name: its location key, else its uninstall entry's InstallLocation (stored in quotes).
!macro ThanhAmReadOldDir
  ReadRegStr $ThanhAmOldDir HKCU "${MANUKEY}\${THANHAM_OLD}" ""
  ${If} $ThanhAmOldDir == ""
    ReadRegStr $ThanhAmOldDir HKCU "${THANHAM_OLDKEY}" "InstallLocation"
    StrCpy $R4 $ThanhAmOldDir 1
    ${If} $R4 == "$\""
      StrCpy $ThanhAmOldDir $ThanhAmOldDir -1 1
    ${EndIf}
  ${EndIf}
!macroend

; Removes what this app put in the old default folder, only when $INSTDIR is neither that folder nor inside it and the folder
; holds a part of this app (runtime or worker left by an interrupted removal counts). Two phases: if runtime or worker cannot
; go, the exe and uninstall.exe stay, so the old entry still works and the next install or uninstall tries again. A file of
; the user's keeps the folder.
!macro ThanhAmRemoveOld
  !insertmacro ThanhAmInside $R6 "${THANHAM_OLDDIR}"
  ${If} $R6 = 0
    ${If} ${FileExists} "${THANHAM_OLDDIR}\${MAINBINARYNAME}.exe"
    ${OrIf} ${FileExists} "${THANHAM_OLDDIR}\uninstall.exe"
    ${OrIf} ${FileExists} "${THANHAM_OLDDIR}\runtime\*.*"
    ${OrIf} ${FileExists} "${THANHAM_OLDDIR}\worker\*.*"
      ClearErrors
      RMDir /r "${THANHAM_OLDDIR}\runtime"
      RMDir /r "${THANHAM_OLDDIR}\worker"
      ${IfNot} ${Errors}
        Delete "${THANHAM_OLDDIR}\${MAINBINARYNAME}.exe"
        Delete "${THANHAM_OLDDIR}\uninstall.exe"
        Delete "${THANHAM_OLDDIR}\LICENSE.txt"
        Delete "${THANHAM_OLDDIR}\THIRD-PARTY-NOTICES.txt"
        RMDir "${THANHAM_OLDDIR}"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

; The old entry and location key go only when that install is gone or reused: its folder is $INSTDIR, or its exe is gone
; (removed above, or a custom folder removed by hand), or there is no old key and the old default folder has no exe.
; Otherwise (a third folder, or $INSTDIR inside the old default folder) both entries stay.
!macro ThanhAmDeleteOldKeys
  StrCpy $R6 0
  ${If} $ThanhAmOldDir == ""
    ${IfNot} ${FileExists} "${THANHAM_OLDDIR}\${MAINBINARYNAME}.exe"
      StrCpy $R6 1
    ${EndIf}
  ${ElseIf} $ThanhAmOldDir == $INSTDIR
    StrCpy $R6 1
  ${ElseIfNot} ${FileExists} "$ThanhAmOldDir\${MAINBINARYNAME}.exe"
    StrCpy $R6 1
  ${EndIf}
  ${If} $R6 = 1
    DeleteRegKey HKCU "${THANHAM_OLDKEY}"
    DeleteRegKey HKCU "${MANUKEY}\${THANHAM_OLD}"
  ${EndIf}
!macroend

; result = 1 when the shortcut exists and opens the exe in the old default folder or in $INSTDIR.
!macro ThanhAmOurLnk result lnk
  StrCpy ${result} 0
  ${If} ${FileExists} "${lnk}"
    !insertmacro IsShortcutTarget "${lnk}" "${THANHAM_OLDDIR}\${MAINBINARYNAME}.exe"
    Pop ${result}
    ${If} ${result} = 0
      !insertmacro IsShortcutTarget "${lnk}" "$INSTDIR\${MAINBINARYNAME}.exe"
      Pop ${result}
    ${EndIf}
  ${EndIf}
!macroend

; Deletes the old name's shortcut in dir when it opens this app; $R5 = 1 when it did.
!macro ThanhAmDeleteOldLnk dir
  !insertmacro ThanhAmOurLnk $R5 "${dir}\${THANHAM_OLD}.lnk"
  ${If} $R5 = 1
    Delete "${dir}\${THANHAM_OLD}.lnk"
  ${EndIf}
!macroend

; Replaces the old name's shortcut in dir with one of the new name (the template creates none in update mode), unless /NS.
!macro ThanhAmSwapLnk dir
  !insertmacro ThanhAmDeleteOldLnk "${dir}"
  ${If} $R5 = 1
  ${AndIf} $NoShortcutMode <> 1
    CreateShortcut "${dir}\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "${dir}\${PRODUCTNAME}.lnk"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  System::Store "s"
  !insertmacro ThanhAmReadOldDir
  ; An old install in a folder of the user's choice is updated there, unless this run was given a folder of its own.
  ${If} $ThanhAmOldDir != ""
  ${AndIf} $ThanhAmOldDir != "${THANHAM_OLDDIR}"
  ${AndIf} ${FileExists} "$ThanhAmOldDir\${MAINBINARYNAME}.exe"
  ${AndIf} $INSTDIR == "$LOCALAPPDATA\${PRODUCTNAME}"
    StrCpy $INSTDIR $ThanhAmOldDir
    SetOutPath $INSTDIR
    RMDir "$LOCALAPPDATA\${PRODUCTNAME}"
    ; The template checks only the exe of the folder it set. A process holding python.exe would stop `File` on an
    ; Abort/Retry/Ignore box, which hangs a passive install.
    !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
    !insertmacro CheckIfAppIsRunning "$INSTDIR\runtime\python\python.exe" "${PRODUCTNAME}"
  ${EndIf}
  ${If} ${FileExists} "${THANHAM_OLDDIR}\${MAINBINARYNAME}.exe"
    !insertmacro CheckIfAppIsRunning "${THANHAM_OLDDIR}\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
    !insertmacro CheckIfAppIsRunning "${THANHAM_OLDDIR}\runtime\python\python.exe" "${PRODUCTNAME}"
  ${EndIf}
  System::Store "l"
  Delete "$INSTDIR\runtime\python\Lib\site-packages\torch\lib\libiompstubs5md.dll"
  Delete "$INSTDIR\runtime\python\Lib\site-packages\ctranslate2\cudnn64_9.dll"
  !insertmacro ThanhAmRemovePackage "torch"
  !insertmacro ThanhAmRemovePackage "demucs"
  !insertmacro ThanhAmRemovePackage "julius"
  !insertmacro ThanhAmRemovePackage "einops"
  !insertmacro ThanhAmRemovePackage "safetensors"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  System::Store "s"
  ; Apps & Features keeps the Vietnamese name.
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayName" "${THANHAM_OLD}"
  !insertmacro ThanhAmSwapLnk "$SMPROGRAMS"
  !insertmacro ThanhAmSwapLnk "$DESKTOP"
  ; A taskbar pin keeps its file name; it is pointed at the new exe and folder (SetShortcutTarget plus the working
  ; directory).
  !insertmacro ThanhAmOurLnk $R5 "${THANHAM_PIN}"
  ${If} $R5 = 1
    !insertmacro ComHlpr_CreateInProcInstance ${CLSID_ShellLink} ${IID_IShellLink} r0 ""
    ${If} $0 P<> 0
      ${IUnknown::QueryInterface} $0 '("${IID_IPersistFile}",.r1)'
      ${If} $1 P<> 0
        ${IPersistFile::Load} $1 '("${THANHAM_PIN}", ${STGM_READWRITE})'
        ${IShellLink::SetPath} $0 '(w "$INSTDIR\${MAINBINARYNAME}.exe")'
        ${IShellLink::SetWorkingDirectory} $0 '(w "$INSTDIR")'
        ${IPersistFile::Save} $1 '("${THANHAM_PIN}",1)'
        ${IUnknown::Release} $1 ""
      ${EndIf}
      ${IUnknown::Release} $0 ""
    ${EndIf}
  ${EndIf}
  !insertmacro ThanhAmRemoveOld
  !insertmacro ThanhAmDeleteOldKeys
  System::Store "l"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Read before the template deletes the files; the uninstaller is its own process, so the old folder is read again.
  StrCpy $ThanhAmOwned 0
  ${If} $INSTDIR != ""
  ${AndIf} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
  ${AndIf} ${FileExists} "$INSTDIR\runtime\python\python.exe"
    StrCpy $ThanhAmOwned 1
  ${EndIf}
  System::Store "s"
  !insertmacro ThanhAmReadOldDir
  System::Store "l"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    System::Store "s"
    ; Python writes __pycache__ folders the template's file list does not cover. Only names this app owns go recursively,
    ; so a folder shared with other files keeps them.
    ${If} $ThanhAmOwned = 1
      RMDir /r "$INSTDIR\runtime\python"
      RMDir /r "$INSTDIR\runtime\ffmpeg"
      RMDir "$INSTDIR\runtime"
      RMDir /r "$INSTDIR\worker\__pycache__"
      RMDir "$INSTDIR\worker"
      RMDir "$INSTDIR"
    ${EndIf}
    !insertmacro ThanhAmRemoveOld
    !insertmacro ThanhAmDeleteOldKeys
    !insertmacro ThanhAmDeleteOldLnk "$SMPROGRAMS"
    !insertmacro ThanhAmDeleteOldLnk "$DESKTOP"
    System::Store "l"
  ${EndIf}
!macroend
