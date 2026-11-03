@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$w=New-Object -ComObject WScript.Shell; $s=$w.CreateShortcut([Environment]::GetFolderPath('Desktop')+'\鲸倩.lnk'); $s.TargetPath='%~dp0启动鲸倩.cmd'; $s.WorkingDirectory='%~dp0'; $s.IconLocation='%~dp0desktop\icon.ico'; $s.Description='鲸倩（绿色版）'; $s.Save()"
echo 桌面快捷方式建好了（鲸倩）。
timeout /t 2 >nul
