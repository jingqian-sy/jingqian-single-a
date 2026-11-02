# 触手的「找控件」：用 Windows UI Automation 按名字找，比看图猜坐标准
# 用法：powershell -File uia.ps1 -Name "开始" [-Max 10] [-Window "记事本"]
param(
  [string]$Name = "",
  [int]$Max = 10,
  [string]$Window = ""
)

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$res = New-Object System.Collections.ArrayList

function Add-Element($el, $winTitle) {
  try {
    $r = $el.Current.BoundingRectangle
    if ($r.Width -le 0 -or $r.Height -le 0) { return }
    [void]$res.Add([pscustomobject]@{
      name  = $el.Current.Name
      type  = ($el.Current.ControlType.ProgrammaticName -replace 'ControlType\.', '')
      x     = [int]($r.X + $r.Width / 2)
      y     = [int]($r.Y + $r.Height / 2)
      w     = [int]$r.Width
      h     = [int]$r.Height
      window = $winTitle
    })
  } catch { }
}

$root = $AE::RootElement
$wins = $root.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)

foreach ($w in $wins) {
  try {
    $wTitle = $w.Current.Name
    if ($wTitle -eq "") { continue }
    if ($Window -ne "" -and $wTitle -notlike "*$Window*") { continue }

    # 先按精确名字找
    $cond = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $Name)
    $hits = $w.FindAll($TS::Descendants, $cond)
    foreach ($h in $hits) { Add-Element $h $wTitle; if ($res.Count -ge $Max) { break } }

    # 不够就模糊找（名字包含关键字）
    if ($res.Count -lt $Max -and $Name -ne "") {
      $all = $w.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
      foreach ($a in $all) {
        if ($res.Count -ge $Max) { break }
        try {
          $n = $a.Current.Name
          if ($n -and $n -like "*$Name*") { Add-Element $a $wTitle }
        } catch { }
      }
    }
    if ($res.Count -ge $Max) { break }
  } catch { }
}

$out = $res | Select-Object -First $Max
if ($out.Count -eq 0) {
  Write-Output '{"ok":false,"items":[]}'
} else {
  $obj = [pscustomobject]@{ ok = $true; items = @($out) }
  Write-Output ($obj | ConvertTo-Json -Depth 4 -Compress)
}
