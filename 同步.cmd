@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   把这份干净版同步到最新代码（数据不动）
echo   ----------------------------------------------
git pull origin main
if errorlevel 1 (
  echo.
  echo   [!] 拉取失败。看看是不是没装 git，或者网络不通。
  pause
  exit /b 1
)
echo.
echo   [ok] 代码已经是最新的。数据、config.json 没动。
echo   要重启服务：关掉旧的（任务管理器里结束了 node），再双击 run.cmd。
echo.
pause
