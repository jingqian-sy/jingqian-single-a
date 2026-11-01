@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ============================================
echo   鲸倩单A 雏版 · 一键发布
echo   用法： 一键发布.cmd https://github.com/你的账号/jingqian-single-a.git
echo ============================================
echo.

if "%~1"=="" (
  echo   没给仓库地址。
  echo   先在 GitHub 建一个空仓库，然后把地址当参数传进来。
  echo   例：一键发布.cmd https://github.com/abc/jingqian-single-a.git
  pause
  exit /b 1
)

set REPO=%~1

where git >nul 2>nul
if errorlevel 1 (
  echo   没找到 git。
  echo   装一个：https://git-scm.com/download/win  ^(或者用 GitHub Desktop^)
  echo   装完重开一个窗口再跑这个脚本。
  pause
  exit /b 1
)

for /f "delims=" %%i in ('git config user.name') do set GITNAME=%%i
if "!GITNAME!"=="" (
  echo   第一次用 git，要先设名字和邮箱：
  set /p GNAME=  你的名字: 
  set /p GMAIL=  你的邮箱: 
  git config --global user.name "!GNAME!"
  git config --global user.email "!GMAIL!"
)

if not exist ".git" (
  echo   [1/5] 初始化仓库
  git init -b main || goto :fail
) else (
  echo   [1/5] 已有仓库，跳过初始化
)

echo   [2/5] 检查敏感文件
if exist "config.json" (
  findstr /C:"sk-" config.json >nul && (
    echo   ！config.json 里像是还留着真 key。这个文件在 .gitignore 里不会被提交，
    echo     但你自己确认一下。
  )
)

echo   [3/5] 暂存并提交
git add . || goto :fail
git commit -m "init: 鲸倩单A 雏版 1.0.0" || echo   （没有新改动可提交，继续）

echo   [4/5] 设置远端
git remote remove origin >nul 2>nul
git remote add origin "!REPO!" || goto :fail

echo   [5/5] 推送
git push -u origin main || goto :fail
git tag v1.0.0 2>nul
git push --tags 2>nul

echo.
echo   推上去了。接下来去仓库 Settings - Actions 看一眼 CI 是不是绿的。
echo   绿的以后，README 顶上的徽章才会亮。
echo.
pause
exit /b 0

:fail
echo.
echo   有一步没成功，把上面的报错发她看。
pause
exit /b 1
