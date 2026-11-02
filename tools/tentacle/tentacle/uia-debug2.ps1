Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$root = $AE::RootElement
$wins = $root.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)
foreach ($w in $wins) {
  try {
    $n = $w.Current.Name
    if ($n -notlike "*文件资源管理器*") { continue }
    Write-Output ("窗口: " + $n)
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $all = $w.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $sw.Stop()
    Write-Output ("子孙数: " + $all.Count + " 耗时 " + $sw.ElapsedMilliseconds + "ms")
    $k = 0
    foreach ($a in $all) {
      try {
        $nm = $a.Current.Name
        $tp = $a.Current.ControlType.ProgrammaticName
        if ($nm) {
          Write-Output ("  [" + $tp + "] " + $nm)
          $k++
        }
      } catch { }
      if ($k -ge 15) { break }
    }
  } catch { Write-Output ("异常: " + $_.Exception.Message) }
}
