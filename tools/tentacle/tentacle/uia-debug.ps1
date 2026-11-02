Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$root = $AE::RootElement
$wins = $root.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)
Write-Output ("顶层窗口数: " + $wins.Count)
$i = 0
foreach ($w in $wins) {
  $n = ""
  try { $n = $w.Current.Name } catch { }
  if ($n -ne "") { Write-Output (" - " + $n) ; $i++ }
  if ($i -ge 12) { break }
}
Write-Output "--- 找鲸倩窗口的子孙数 ---"
foreach ($w in $wins) {
  try {
    if ($w.Current.Name -like "*鲸倩*") {
      $all = $w.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
      Write-Output ("窗口 " + $w.Current.Name + " 子孙数: " + $all.Count)
      $k = 0
      foreach ($a in $all) {
        try {
          $nm = $a.Current.Name
          if ($nm) { Write-Output ("   [" + $a.Current.ControlType.ProgrammaticName + "] " + $nm); $k++ }
        } catch { }
        if ($k -ge 10) { break }
      }
    }
  } catch { }
}
