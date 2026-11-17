@echo off
rem Builds the shim libiomp5md.dll and its ABI test; called by setup-runtime.ps1.
rem usage: build.cmd <vcvars64.bat> <dir with libomp.lib> <out dir containing libiomp5md.def>
setlocal
call "%~1" >nul || exit /b 1
set "OUT=%~3"
ml64 /nologo /c /Fo"%OUT%\vcomp_call.obj" "%~dp0vcomp_call.asm" || exit /b 1
cl /nologo /O2 /W3 /MD /c /Fo"%OUT%\vcomp_shim.obj" "%~dp0vcomp_shim.c" || exit /b 1
link /nologo /DLL /OUT:"%OUT%\libiomp5md.dll" /DEF:"%OUT%\libiomp5md.def" /IMPLIB:"%OUT%\libiomp5md.lib" "%OUT%\vcomp_shim.obj" "%OUT%\vcomp_call.obj" "%~2\libomp.lib" || exit /b 1
cl /nologo /O2 /openmp /MD /c /Fo"%OUT%\semantics_test.obj" "%~dp0semantics_test.c" || exit /b 1
link /nologo /OUT:"%OUT%\semantics_test.exe" "%OUT%\semantics_test.obj" "%OUT%\libiomp5md.lib" /NODEFAULTLIB:vcomp.lib || exit /b 1
