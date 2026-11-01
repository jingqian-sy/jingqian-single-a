# 鲸倩 · 单A 雏版 安装脚本
# 特点：没装 Node 也能装 —— 会自己下一份便携版放到安装目录里
param([switch]$Quiet)

$ErrorActionPreference = 'Stop'
$src = Split-Path -Parent $MyInvocation.MyCommand.Path
$dest = Join-Path $env:LOCALAPPDATA 'Jingqian'
$nodeVer = '22.14.0'

function Say($t) { Write-Host $t }

Say '=========================================='
Say '  鲸倩 单A 雏版 安装'
Say "  装到 $dest"
Say '  不动系统设置：纯拷贝 + 快捷方式'
Say '=========================================='
Say ''

New-Item -ItemType Directory -Path $dest -Force | Out-Null

function Find-LocalNode {
  $bundled = Join-Path $dest ('runtime\node-v' + $nodeVer + '-win-x64\node.exe')
  if (Test-Path $bundled) { return $bundled }
  return $null
}

$nodePath = $null
$cmdInfo = Get-Command node -ErrorAction SilentlyContinue
if ($cmdInfo) { $nodePath = $cmdInfo.Source }
if (-not $nodePath) { $nodePath = Find-LocalNode }

if (-not $nodePath) {
  Say '[准备] 这台机器没装 Node，正在下一份便携版（约 30MB，只下一次）'
  $zip = Join-Path $env:TEMP ('node-' + $nodeVer + '.zip')
  $url = 'https://nodejs.org/dist/v' + $nodeVer + '/node-v' + $nodeVer + '-win-x64.zip'
  try {
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -TimeoutSec 900
    $rt = Join-Path $dest 'runtime'
    New-Item -ItemType Directory -Path $rt -Force | Out-Null
    Expand-Archive -Path $zip -DestinationPath $rt -Force
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    $nodePath = Find-LocalNode
  } catch {
    Say ('! 下载 Node 失败：' + $_.Exception.Message)
    Say '  可以手动装一个：https://nodejs.org/  然后重跑这个安装。'
    if (-not $Quiet) { Read-Host '按回车退出' | Out-Null }
    exit 1
  }
}
Say ('[1/4] Node: ' + $nodePath)

Say '[2/4] 拷贝文件'
foreach ($dir in @('src', 'public', 'evals')) {
  $from = Join-Path $src $dir
  if (Test-Path $from) { robocopy $from (Join-Path $dest $dir) /E /NFL /NDL /NJH /NJS /NP | Out-Null }
}
foreach ($f in @('package.json', 'README.md', 'LICENSE', 'CHANGELOG.md', 'config.example.json')) {
  $p = Join-Path $src $f
  if (Test-Path $p) { Copy-Item $p (Join-Path $dest $f) -Force }
}
$cfg = Join-Path $dest 'config.json'
if (-not (Test-Path $cfg)) { Copy-Item (Join-Path $src 'config.example.json') $cfg -Force }

Say '[3/4] 生成启动脚本'
$launchLines = @(
  '# 启动鲸倩：没在跑就起服务，然后开浏览器',
  '$here = Split-Path -Parent $MyInvocation.MyCommand.Path',
  'Set-Location $here',
  "$url = 'http://127.0.0.1:7889/'",
  '$alive = $false',
  'try {',
  '  $c = New-Object System.Net.Sockets.TcpClient',
  "  $t = $c.BeginConnect('127.0.0.1', 7889, $null, $null)",
  '  if ($t.AsyncWaitHandle.WaitOne(500)) { $c.EndConnect($t); $alive = $true }',
  '  $c.Close()',
  '} catch { }',
  'if (-not $alive) {',
  ('  Start-Process -FilePath ''' + $nodePath + ''' -ArgumentList ''src\server.js'' -WorkingDirectory $here -WindowStyle Hidden'),
  '  Start-Sleep -Seconds 3',
  '}',
  'Start-Process $url'
)
Set-Content -Path (Join-Path $dest '启动鲸倩.ps1') -Value $launchLines -Encoding UTF8

Say '[4/4] 建快捷方式（桌面 + 开始菜单）'
$shell = New-Object -ComObject WScript.Shell
$ps = (Get-Command powershell).Source
$launchPath = Join-Path $dest '启动鲸倩.ps1'

$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = $shell.CreateShortcut((Join-Path $desktop '鲸倩.lnk'))
$lnk.TargetPath = $ps
$lnk.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $launchPath + '"'
$lnk.WorkingDirectory = $dest
$lnk.IconLocation = "$env:SystemRoot\System32\shell32.dll,13"
$lnk.Description = '鲸倩 · 单A 雏版'
$lnk.Save()

$startDir = Join-Path ([Environment]::GetFolderPath('Programs')) '鲸倩'
if (-not (Test-Path $startDir)) { New-Item -ItemType Directory -Path $startDir -Force | Out-Null }
$lnk2 = $shell.CreateShortcut((Join-Path $startDir '启动鲸倩.lnk'))
$lnk2.TargetPath = $ps
$lnk2.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $launchPath + '"'
$lnk2.WorkingDirectory = $dest
$lnk2.Save()

$urlFile = Join-Path $startDir '中控台.url'
Set-Content -Path $urlFile -Value '[InternetShortcut]' -Encoding ASCII
Add-Content -Path $urlFile -Value 'URL=http://127.0.0.1:7889/console.html' -Encoding ASCII

Say ''
Say '装好了。桌面有「鲸倩」，双击就开。'
Say '第一次用：从开始菜单打开「中控台」，填一家模型密钥；'
Say '或者 ollama pull qwen3:8b 用本地模型，就不用密钥。'

if (-not $Quiet) {
  $go = Read-Host '现在启动吗？(y/n)'
  if ($go -match '^[yY]') { Start-Process $ps -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "' + $launchPath + '"') }
  Read-Host '按回车退出' | Out-Null
}
