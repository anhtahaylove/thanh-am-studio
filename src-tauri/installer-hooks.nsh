; Files that 1.0.15 installed and later versions no longer ship: Intel's OpenMP stub library (Intel EULA) and NVIDIA
; cuDNN. The updater installs over the old version without uninstalling it, so they would otherwise stay behind.
!macro NSIS_HOOK_PREINSTALL
  Delete "$INSTDIR\runtime\python\Lib\site-packages\torch\lib\libiompstubs5md.dll"
  Delete "$INSTDIR\runtime\python\Lib\site-packages\ctranslate2\cudnn64_9.dll"
!macroend
