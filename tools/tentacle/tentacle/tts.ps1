param(
  [Parameter(Mandatory = $true)][string]$Text,
  [string]$Voice = "",
  [int]$Rate = 0,
  [int]$Volume = 100,
  [string]$SaveTo = ""
)

# 离线说话：用 Windows 自带语音（中文是 Huihui）。要自然声就走 edge-tts，这里只做兜底。
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.Rate = [Math]::Max(-10, [Math]::Min(10, $Rate))
$s.Volume = [Math]::Max(0, [Math]::Min(100, $Volume))

if ($Voice -ne "") {
  try { $s.SelectVoice($Voice) } catch { }
} else {
  $cn = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like "zh-*" } | Select-Object -First 1
  if ($cn) { try { $s.SelectVoice($cn.VoiceInfo.Name) } catch { } }
}

if ($SaveTo -ne "") {
  $s.SetOutputToWaveFile($SaveTo)
  $s.Speak($Text)
  $s.SetOutputToNull()
  Write-Output $SaveTo
} else {
  $s.Speak($Text)
  Write-Output "ok"
}
