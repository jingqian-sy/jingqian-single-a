@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem 鲸倩 · 单A 雏版 · 30 秒演示
rem 三步：记一件事 → 问回来 → 跑一条白名单命令。
rem 不需要真 key：优先本机 Ollama；一个模型都没有会明确告诉你缺什么。

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   没找到 node。先装 Node.js 22 或以上：https://nodejs.org/
  echo.
  pause
  exit /b 1
)

node demo.js
echo.
pause
endlocal
