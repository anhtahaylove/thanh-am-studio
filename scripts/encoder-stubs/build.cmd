@echo off
rem Builds the x264 and x265 stand-in DLLs (no CRT, no entry point); called by setup-runtime.ps1.
rem usage: build.cmd <vcvars64.bat> <out dir>
setlocal
call "%~1" >nul || exit /b 1
for %%n in (x264 x265) do (
    cl /nologo /O2 /W3 /GS- /Zl /c /Fo"%~2\%%n.obj" "%~dp0%%n.c" || exit /b 1
    link /nologo /DLL /NOENTRY /NODEFAULTLIB /OUT:"%~2\%%n.dll" "%~2\%%n.obj" || exit /b 1
)
