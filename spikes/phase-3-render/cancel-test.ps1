# Tiêu chí 4 — huỷ giữa chừng có kill được TOÀN BỘ descendant hay không.
# Chiến lược: kill CHỈ process cha (cách naive mà một implementation cẩu thả sẽ làm),
# rồi đếm descendant còn sống. Nếu còn sống => R6.6 buộc phải kill cả cây, không chỉ cha.
param(
  [string]$Repo    = "C:\WorkHere\Coding\vidcom-v2",
  [string]$Project,
  [string]$Out,
  [string]$FfmpegDir,
  [int]$WaitForChildrenSec = 120,
  [int]$SettleSec = 6,
  [int]$KillAfterSec = 0
)

$ErrorActionPreference = "Continue"
if ($FfmpegDir) { $env:PATH = "$FfmpegDir;$env:PATH" }

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
    if ($map.ContainsKey($cur)) {
      foreach ($child in $map[$cur]) { $result += $child; $queue.Enqueue([int]$child.ProcessId) }
    }
  }
  return $result
}

$interesting = @("chrome-headless-shell", "chrome", "ffmpeg", "ffprobe", "node")

"=== BASELINE (trước khi render) ==="
$baseline = Get-Process | Where-Object { $interesting -contains $_.ProcessName } |
            Select-Object Id, ProcessName
$baseline | Group-Object ProcessName | ForEach-Object { "  $($_.Name): $($_.Count)" }
$baselineIds = @($baseline | ForEach-Object { $_.Id })

"=== SPAWN render ==="
$args = @("$Repo\node_modules\hyperframes\bin\hyperframes.mjs", "render", $Project,
          "-o", $Out, "--quality", "draft", "--workers", "1", "--quiet")
$proc = Start-Process -FilePath "node" -ArgumentList $args -PassThru -NoNewWindow `
        -RedirectStandardOutput "$PSScriptRoot\cancel-stdout.log" `
        -RedirectStandardError  "$PSScriptRoot\cancel-stderr.log"
"  parent node PID = $($proc.Id)"

"=== CHỜ descendant chrome/ffmpeg xuất hiện ==="
$sw = [Diagnostics.Stopwatch]::StartNew()
$seen = @()
while ($sw.Elapsed.TotalSeconds -lt $WaitForChildrenSec) {
  if ($proc.HasExited) { "  !! render đã exit trước khi kịp huỷ (code=$($proc.ExitCode))"; break }
  $d = Get-Descendants $proc.Id
  $seen = @($d | Where-Object { $_.Name -match "chrome|ffmpeg" })
  if ($seen.Count -gt 0) { break }
  Start-Sleep -Milliseconds 500
}
"  sau $([int]$sw.Elapsed.TotalSeconds)s: thấy $($seen.Count) descendant chrome/ffmpeg"
$allDesc = Get-Descendants $proc.Id
foreach ($p in $allDesc) { "    PID $($p.ProcessId)  $($p.Name)  (parent $($p.ParentProcessId))" }
$descIds = @($allDesc | ForEach-Object { [int]$_.ProcessId })

if ($proc.HasExited) { "KẾT LUẬN: không tạo được cửa sổ huỷ — xem log"; exit 2 }

if ($KillAfterSec -gt 0) {
  "  chờ thêm $KillAfterSec s để vào sâu hơn trong render"
  Start-Sleep -Seconds $KillAfterSec
  $allDesc = Get-Descendants $proc.Id
  $descIds = @($allDesc | ForEach-Object { [int]$_.ProcessId })
  "  cây process tại thời điểm huỷ: $($descIds.Count) descendant"
  foreach ($p in $allDesc) { "    PID $($p.ProcessId)  $($p.Name)" }
}

"=== KILL CHỈ process cha (naive, không /T) ==="
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
"  đã kill PID $($proc.Id); chờ $SettleSec s để hệ thống ổn định"
Start-Sleep -Seconds $SettleSec

"=== DESCENDANT CÒN SỐNG SAU KHI KILL CHA ==="
$survivors = @()
foreach ($id in $descIds) {
  $alive = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($alive) { $survivors += $alive; "  SỐNG: PID $($alive.Id)  $($alive.ProcessName)  CPU=$([math]::Round($alive.CPU,2))s" }
}
if ($survivors.Count -eq 0) { "  (không còn descendant nào)" }

"=== KẾT LUẬN TIÊU CHÍ 4 ==="
if ($survivors.Count -gt 0) {
  "  FAIL-NAIVE: kill process cha KHÔNG đủ — $($survivors.Count) descendant còn sống."
  "  => R6.6 buộc phải kill cả cây process (taskkill /T hoặc job object), không chỉ pid cha."
} else {
  "  PASS-NAIVE: kill cha là đủ, descendant tự chết theo."
}

"=== DỌN (taskkill /T /F) ==="
foreach ($p in $survivors) {
  & taskkill /PID $p.Id /T /F 2>&1 | Out-String | ForEach-Object { "  $_".TrimEnd() }
}
Start-Sleep -Seconds 2
$leftover = @()
foreach ($id in $descIds) { if (Get-Process -Id $id -ErrorAction SilentlyContinue) { $leftover += $id } }
"  sau taskkill /T: còn $($leftover.Count) process"

"=== ARTIFACT SAU KHI HUỶ ==="
if (Test-Path $Out) {
  "  OUTPUT TỒN TẠI: $Out — $((Get-Item $Out).Length) bytes  <-- cần kiểm có bị công bố nhầm không"
} else {
  "  output không tồn tại (đúng: huỷ thì không công bố artifact)"
}
