# 打包绿色便携版：一个文件夹带走（程序 + node 运行时 + 空数据目录）
# 用法：powershell -ExecutionPolicy Bypass -File tools\build-portable.ps1
# 产物：dist\jingqian-portable-<版本>\ 和同名 .zip
param([string]$OutRoot = "")

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$pkg = Get-Content (Join-Path $repo 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$ver = $pkg.version
if (-not $OutRoot) { $OutRoot = Join-Path $repo 'dist' }
$name = "jingqian-portable-$ver"
$out = Join-Path $OutRoot $name
$zip = Join-Path $OutRoot ($name + '.zip')

if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Path $out -Force | Out-Null
foreach ($d in @('src', 'public', 'docs', 'plugins-example')) {
  $from = Join-Path $repo $d
  if (Test-Path $from) { robocopy $from (Join-Path $out $d) /E /NFL /NDL /NJH /NJS /NP /XD data .run .tmp | Out-Null }
}
# desktop 只带跑起来要用的：exe + 图标。
# 源码(Shell.cs)、自检截图(_verify-*.png)、本机状态文件(tutorial-seen / ui-window)、编译脚本都不进包。
robocopy (Join-Path $repo 'desktop') (Join-Path $out 'desktop') /E /NFL /NDL /NJH /NJS /NP `
  /XF 'Shell.cs' '_verify-*.png' 'tutorial-seen.txt' 'ui-window.txt' 'build-desktop.cmd' '*.pdb' | Out-Null
foreach ($f in @('package.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'config.example.json', '启动鲸倩.cmd', '创建桌面快捷方式.cmd')) {
  $p = Join-Path $repo $f
  if (Test-Path $p) { Copy-Item $p (Join-Path $out $f) -Force }
}
# batches-must-be-crlf: 批处理必须 CRLF + 无 BOM，否则 cmd.exe 把行读碎、双击闪退
foreach ($f in @('启动鲸倩.cmd', '创建桌面快捷方式.cmd')) {
  $p = Join-Path $out $f
  if (Test-Path $p) {
    $x = [IO.File]::ReadAllText($p)
    $x = $x -replace "`r`n", "`n" -replace "`n", "`r`n"
    [IO.File]::WriteAllText($p, $x, (New-Object System.Text.UTF8Encoding($false)))
  }
}
# node 运行时：优先用本机装好的那份
$nodeRuntime = Join-Path $env:LOCALAPPDATA 'Jingqian\runtime'
# fallback-to-dist-runtime: 本机安装被删过时，用 dist 里旧包带的运行时
if (-not (Test-Path $nodeRuntime)) {
  $cand = Get-ChildItem (Join-Path $repo 'dist') -Directory -Filter 'jingqian-portable-*' -ErrorAction SilentlyContinue |
    ForEach-Object { Join-Path $_.FullName 'runtime' } |
    Where-Object { Test-Path (Join-Path $_ 'node-v22.14.0-win-x64\node.exe') } |
    Select-Object -First 1
  if ($cand) { $nodeRuntime = $cand }
}
if (-not (Test-Path $nodeRuntime)) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) {
    $nodeRuntime = Split-Path -Parent $cmd.Source
    New-Item -ItemType Directory -Path (Join-Path $out 'runtime') -Force | Out-Null
    Copy-Item (Join-Path $nodeRuntime 'node.exe') (Join-Path $out 'runtime\node.exe') -Force
  } else {
    throw '没找到 node 运行时：先装一个 Node 22，或把便携版运行时放到 %LOCALAPPDATA%\Jingqian\runtime'
  }
} else {
  robocopy $nodeRuntime (Join-Path $out 'runtime') /E /NFL /NDL /NJH /NJS /NP | Out-Null
}
New-Item -ItemType Directory -Path (Join-Path $out 'data') -Force | Out-Null

if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $out '*') -DestinationPath $zip -CompressionLevel Optimal
$mb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host ("便携版打包好了：{0}（{1} MB）" -f $zip, $mb)
