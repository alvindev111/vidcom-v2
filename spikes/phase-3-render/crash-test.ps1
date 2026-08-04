# Tiêu chí 5 — crash giữa lúc render: có để lại file tạm / MP4 trông-như-hợp-lệ không,
# và artifact có bị công bố nhầm không.
# Khác cancel-test: ở đây KHÔNG dọn gì sau khi kill, để soi đúng những gì crash để lại.
param(
  [string]$Repo = "C:\WorkHere\Coding\vidcom-v2",
  [string]$Project,
  [string]$Out,
  [string]$FfmpegDir,
  [int]$KillAfterSec = 0,           # 0 = kill ngay khi thấy ffmpeg/chrome
  [int]$WaitForChildrenSec = 120
)

$ErrorActionPreference = "Continue"
if ($FfmpegDir) { $env:PATH = "$FfmpegDir;$env:PATH" }
$outDir = Split-Path -Parent $Out

function Snapshot([string]$label, [string]$dir) {
  "--- $label : $dir"
  if (-not (Test-Path $dir)) { "    (không tồn tại)"; return @() }
  $items = Get-ChildItem -Path $dir -Recurse -Force -ErrorAction SilentlyContinue
  if ($items.Count -eq 0) { "    (rỗng)" }
  foreach ($i in $items) {
    $size = if ($i.PSIsContainer) { "<dir>" } else { "$($i.Length) B" }
    "    $($i.FullName.Replace($dir,'.'))  $size"
  }
  return $items
}

function Get-Descendants([int]$RootPid) {
  $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name
  $map = @{}
  foreach ($p in $all) {
    if (-not $map.ContainsKey([int]$p.ParentProcessId)) { $map[[int]$p.ParentProcessId] = @() }
    $map[[int]$p.ParentProcessId] += $p
  }
  $result = @(); $queue = New-Object System.Collections.Queue
  $queue.Enqueue($RootPid)
  while ($queue.Count -gt 0) {
    $cur = [int]$queue.Dequeue()
    if ($map.ContainsKey($cur)) { foreach ($c in $map[$cur]) { $result += $c; $queue.Enqueue([int]$c.ProcessId) } }
  }
  return $result
}

$tempRoot = $env:TEMP
"=== TRƯỚC RENDER ==="
Snapshot "output dir" $outDir | Out-Null
$tmpBefore = @(Get-ChildItem -Path $tempRoot -Directory -Force -ErrorAction SilentlyContinue |
               Where-Object { $_.Name -match "hyperframes|producer|render" } | ForEach-Object { $_.FullName })
"--- temp dirs khớp hyperframes|producer|render: $($tmpBefore.Count)"
$tmpBefore | ForEach-Object { "    $_" }

"=== SPAWN render ==="
$args = @("$Repo\node_modules\hyperframes\bin\hyperframes.mjs", "render", $Project,
          "-o", $Out, "--quality", "draft", "--workers", "1", "--quiet")
$proc = Start-Process -FilePath "node" -ArgumentList $args -PassThru -NoNewWindow `
        -RedirectStandardOutput "$PSScriptRoot\crash-stdout.log" `
        -RedirectStandardError  "$PSScriptRoot\crash-stderr.log"
"  parent node PID = $($proc.Id)"

$sw = [Diagnostics.Stopwatch]::StartNew()
$seen = @()
while ($sw.Elapsed.TotalSeconds -lt $WaitForChildrenSec) {
  if ($proc.HasExited) { "  !! render exit sớm (code=$($proc.ExitCode))"; break }
  $seen = @(Get-Descendants $proc.Id | Where-Object { $_.Name -match "chrome|ffmpeg" })
  if ($seen.Count -gt 0) { break }
  Start-Sleep -Milliseconds 500
}
"  sau $([int]$sw.Elapsed.TotalSeconds)s: $($seen.Count) descendant chrome/ffmpeg"
if ($KillAfterSec -gt 0) { "  chờ thêm $KillAfterSec s cho render đi sâu hơn"; Start-Sleep -Seconds $KillAfterSec }

$descIds = @(Get-Descendants $proc.Id | ForEach-Object { [int]$_.ProcessId })

"=== MÔ PHỎNG CRASH: taskkill /F cả cây, không cho cleanup handler chạy ==="
& taskkill /PID $proc.Id /T /F 2>&1 | Out-String | ForEach-Object { "  $_".TrimEnd() }
Start-Sleep -Seconds 4
$still = @(); foreach ($id in $descIds) { if (Get-Process -Id $id -ErrorAction SilentlyContinue) { $still += $id } }
"  process còn sống sau taskkill /T /F: $($still.Count)"

"=== SAU CRASH — CÁI GÌ CÒN LẠI ==="
Snapshot "output dir" $outDir | Out-Null
$tmpAfter = @(Get-ChildItem -Path $tempRoot -Directory -Force -ErrorAction SilentlyContinue |
              Where-Object { $_.Name -match "hyperframes|producer|render" } | ForEach-Object { $_.FullName })
"--- temp dirs khớp hyperframes|producer|render: $($tmpAfter.Count)"
$newTmp = @($tmpAfter | Where-Object { $tmpBefore -notcontains $_ })
"--- temp dir MỚI do lần render này để lại: $($newTmp.Count)"
foreach ($d in $newTmp) {
  $sz = (Get-ChildItem $d -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
  "    $d  ~$([math]::Round(($sz/1MB),2)) MB"
}

"=== ARTIFACT CÓ BỊ CÔNG BỐ NHẦM KHÔNG ==="
if (Test-Path $Out) {
  $f = Get-Item $Out
  "  OUTPUT TỒN TẠI: $($f.FullName)  $($f.Length) bytes"
  "  => cần ffprobe để biết nó có 'trông như hợp lệ' hay không (bước sau)"
} else {
  "  output KHÔNG tồn tại — crash không công bố artifact (đây là hành vi đúng)"
}
