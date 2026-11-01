# 鲸倩 · 单A 雏版 安装脚本
# 装「软件版」（C# 窗口）+ 保留网页版做兜底调试入口
param([switch]$Quiet)

$ErrorActionPreference = 'Stop'
$src = Split-Path -Parent $MyInvocation.MyCommand.Path
$dest = Join-Path $env:LOCALAPPDATA 'Jingqian'
$app  = Join-Path $dest 'app'
$nodeVer = '22.14.0'

function Say($t) { Write-Host $t }

Say '=========================================='
Say '  鲸倩 单A 雏版 安装（软件版）'
Say "  装到 $app"
Say '  纯拷贝 + 快捷方式，不动系统设置'
Say '=========================================='
Say ''

New-Item -ItemType Directory -Path $app -Force | Out-Null

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
Say ('[1/5] Node: ' + $nodePath)

Say '[2/5] 拷贝程序 + 软件版外壳'
foreach ($dir in @('src', 'public', 'evals', 'desktop', 'docs')) {
  $from = Join-Path $src $dir
  if (Test-Path $from) { robocopy $from (Join-Path $app $dir) /E /NFL /NDL /NJH /NJS /NP | Out-Null }
}
foreach ($f in @('package.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'config.example.json', 'run.cmd')) {
  $p = Join-Path $src $f
  if (Test-Path $p) { Copy-Item $p (Join-Path $app $f) -Force }
}
$cfg = Join-Path $app 'config.json'
if (-not (Test-Path $cfg)) { Copy-Item (Join-Path $src 'config.example.json') $cfg -Force }

$exe = Join-Path $app 'desktop\鲸倩.exe'
$ico = Join-Path $app 'desktop\icon.ico'
if (-not (Test-Path $exe)) {
  Say '! 没找到 desktop\鲸倩.exe（先在仓库根目录跑 desktop\build-desktop.cmd 编一下）'
  Say '  装完可以用网页版兜底：启动鲸倩.ps1'
} else {
  Say ('      软件版：' + $exe)
}

Say '[3/5] 写「网页版兜底」启动脚本'
$launchLines = @(
  '# 网页版兜底入口（开发调试用）：没在跑就起服务，然后开浏览器',
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
Set-Content -Path (Join-Path $app '启动网页版.ps1') -Value $launchLines -Encoding UTF8

Say '[4/5] 建快捷方式（桌面 + 开始菜单，指向软件版 exe，带 icon.ico）'
$shell = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$startDir = Join-Path ([Environment]::GetFolderPath('Programs')) '鲸倩'
if (-not (Test-Path $startDir)) { New-Item -ItemType Directory -Path $startDir -Force | Out-Null }

function New-Shortcut($path) {
  $lnk = $shell.CreateShortcut($path)
  $lnk.TargetPath = $exe
  $lnk.WorkingDirectory = $app
  if (Test-Path $ico) { $lnk.IconLocation = $ico }
  $lnk.Description = '鲸倩 · 单A 雏版（软件版）'
  $lnk.Save()
}

if (Test-Path $exe) {
  New-Shortcut (Join-Path $desktop '鲸倩.lnk')
  New-Shortcut (Join-Path $startDir '鲸倩.lnk')
} else {
  Say '      跳过软件版快捷方式（exe 不在）'
}

# 网页版留一个 URL 快捷方式在开始菜单，标清是调试用
$urlFile = Join-Path $startDir '网页版（调试用）.url'
Set-Content -Path $urlFile -Value '[InternetShortcut]' -Encoding ASCII
Add-Content -Path $urlFile -Value 'URL=http://127.0.0.1:7889/' -Encoding ASCII

Say '[5/5] 完成'
Say ''
if (Test-Path $exe) {
  Say '桌面「鲸倩」双击就开软件版（不跳浏览器）。'
} else {
  Say '这次没装成软件版（缺 exe）；可以用开始菜单里的「网页版（调试用）」。'
}
Say '第一次用：打开软件 → 右上「设置」填模型密钥；或者本机 ollama pull qwen3:8b 用本地模型。'
Say '接 QQ 是可选功能，默认关，见 docs/软件版.md「接 QQ」一节。'

if (-not $Quiet) {
  Read-Host '按回车退出' | Out-Null
}
