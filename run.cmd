@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem 鲸倩 · 单A 雏版 —— 一条命令起来
rem 第一次跑会自动从 config.example.json 复制一份 config.json，记得填一家云端 key。

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   没找到 node。请先装 Node.js 22 或以上：https://nodejs.org/
  echo   装完重开一个窗口再跑 run.cmd。
  echo.
  pause
  exit /b 1
)

if not exist "config.json" (
  copy /y "config.example.json" "config.json" >nul
  echo   已生成 config.json（从样例复制）。要接云端就在里面填 providers 的 key；
  echo   不想填 key 就用本机 Ollama：ollama pull qwen3:8b。
  echo.
)

if not exist "data" mkdir "data"
if not exist "data\workspace" mkdir "data\workspace"

echo   正在起服务，浏览器一会儿自动打开 http://127.0.0.1:7889
start "" cmd /c "timeout /t 2 >nul & start http://127.0.0.1:7889"
node src\server.js
endlocal
