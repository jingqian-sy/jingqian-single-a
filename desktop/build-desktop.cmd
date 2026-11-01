@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem 鲸倩 · 软件版编译脚本
rem 用系统自带的 .NET Framework csc 编，单文件 WinForms，不引任何 NuGet / WebView2。

set "SPEECH=%WINDIR%\Microsoft.NET\assembly\GAC_MSIL\System.Speech\v4.0_4.0.0.0__31bf3856ad364e35\System.Speech.dll"
set "CSC64=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
set "CSC32=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
set "CSC="

if exist "%CSC64%" set "CSC=%CSC64%"
if not exist "%SPEECH%" echo   [!] System.Speech.dll not found (needs .NET 4) - speech features will not build

if not defined CSC (
  echo.
  echo   [!] 没找到 .NET Framework 4.x 的 csc.exe
  echo       找过这两个位置：
  echo         %CSC64%
  echo         %CSC32%
  echo       系统自带 .NET Framework 一般都有；实在没有就装一下 .NET Framework 4.8 运行时。
  echo.
  exit /b 1
)

if not exist "Shell.cs" (
  echo   [!] 当前目录没有 Shell.cs：%~dp0
  exit /b 1
)
if not exist "icon.ico" (
  echo   [!] 当前目录没有 icon.ico，编出来的窗口没图标（继续编）。
)

echo   用 csc：%CSC%
"%CSC%" /nologo /target:winexe /platform:anycpu /optimize+ ^
  /out:"%~dp0鲸倩.exe" ^
  /win32icon:"%~dp0icon.ico" ^
  /r:"%SPEECH%" /r:System.dll /r:System.Core.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll ^
  "%~dp0Shell.cs"

if errorlevel 1 (
  echo.
  echo   [x] 编译失败。看上面 csc 的报错行号，去 desktop\Shell.cs 对应位置改。
  echo       常见原因：少了 System.Web.Extensions 引用、或者用了这版 csc（C# 5）不支持的语法。
  echo.
  exit /b 1
)

echo.
for %%A in ("%~dp0鲸倩.exe") do echo   [ok] 编好了：%%~fA  （%%~zA 字节）
echo        双击就能开窗；服务没起的话它会自己拉。
echo.
endlocal
