@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "desktop\鲸倩.exe" (
  echo 找不到 desktop\鲸倩.exe，这个文件夹不完整。
  pause
  exit /b 1
)
if not exist "config.json" if exist "config.example.json" copy /y "config.example.json" "config.json" >nul
start "" "desktop\鲸倩.exe"
