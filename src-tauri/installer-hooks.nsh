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
!macro NSIS_HOOK_PREINSTALL
  Delete "$INSTDIR\runtime\python\Lib\site-packages\torch\lib\libiompstubs5md.dll"
  Delete "$INSTDIR\runtime\python\Lib\site-packages\ctranslate2\cudnn64_9.dll"
  !insertmacro ThanhAmRemovePackage "torch"
  !insertmacro ThanhAmRemovePackage "demucs"
  !insertmacro ThanhAmRemovePackage "julius"
  !insertmacro ThanhAmRemovePackage "einops"
  !insertmacro ThanhAmRemovePackage "safetensors"
!macroend
