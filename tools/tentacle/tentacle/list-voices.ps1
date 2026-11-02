Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voices = $s.GetInstalledVoices()
Write-Output ("声音数: " + $voices.Count)
foreach ($v in $voices) {
  try {
    Write-Output (" - " + $v.VoiceInfo.Name + " / " + $v.VoiceInfo.Culture + " / " + $v.VoiceInfo.Gender)
  } catch { }
}
