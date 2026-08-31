<#
    start-collector.ps1 - run the collector continuously

        powershell -ExecutionPolicy Bypass -File start-collector.ps1
        powershell -ExecutionPolicy Bypass -File start-collector.ps1 -Status
        powershell -ExecutionPolicy Bypass -File start-collector.ps1 -Stop

    Starts one detached node process that works rounds back to back and
    pushes clubs.json after each one. No scheduler, no waiting for the top
    of the hour. It keeps running after this window is closed, and stops at
    logout or reboot - start it again then.

    Only one may run at a time. Two would fight over the same files and the
    same git branch, and the loser's work would be overwritten.
#>

param(
    [switch]$Stop,
    [switch]$Status,
    [int]$BudgetMinutes = 20,
    [int]$OsmCountries  = 12,
    [int]$OsmParallel   = 3
)

$ErrorActionPreference = "Stop"
$root    = $PSScriptRoot
$pidFile = Join-Path $root "data\collector.pid"
$outLog  = Join-Path $root "data\collector.out.log"

function Get-Collector {
    if (-not (Test-Path $pidFile)) { return $null }
    $id = (Get-Content $pidFile -Raw).Trim()
    if (-not $id) { return $null }
    $p = Get-Process -Id ([int]$id) -ErrorAction SilentlyContinue
    # A recycled PID belonging to something else must not be reported as ours,
    # and must certainly not be killed by -Stop.
    if ($p -and $p.ProcessName -eq 'node') { return $p }
    return $null
}

if ($Status) {
    $p = Get-Collector
    if ($p) {
        $mins = [math]::Round(((Get-Date) - $p.StartTime).TotalMinutes, 1)
        Write-Host ""
        Write-Host "  Running. PID $($p.Id), up $mins minutes." -ForegroundColor Green
        Write-Host "  Log:  $root\data\daemon.log"
        Write-Host "  Data: node daemon.js status"
        Write-Host ""
    } else {
        Write-Host ""
        Write-Host "  Not running. Start it with: powershell -File start-collector.ps1"
        Write-Host ""
    }
    return
}

if ($Stop) {
    $p = Get-Collector
    if ($p) {
        Stop-Process -Id $p.Id -Force
        Remove-Item $pidFile -ErrorAction SilentlyContinue
        Write-Host "  Stopped (PID $($p.Id)). Everything collected so far is in data\." -ForegroundColor Yellow
    } else {
        Write-Host "  Not running."
    }
    return
}

if (-not (Test-Path (Join-Path $root "daemon.js"))) {
    throw "daemon.js is not in $root. Run this from the collector folder."
}
if ($root -match "\\\.claude\\worktrees\\") {
    throw "$root is a git worktree, which gets deleted. Clone the repository somewhere permanent and run this there."
}

$existing = Get-Collector
if ($existing) {
    Write-Host "  Already running (PID $($existing.Id)). Nothing to do." -ForegroundColor Yellow
    Write-Host "  Restart it with:  -Stop  then start again."
    return
}

New-Item -ItemType Directory -Force -Path (Join-Path $root "data") | Out-Null

$env:BUDGET_MINUTES = "$BudgetMinutes"
$env:OSM_COUNTRIES  = "$OsmCountries"
$env:OSM_PARALLEL   = "$OsmParallel"

$node = (Get-Command node).Source
$p = Start-Process -FilePath $node -ArgumentList "daemon.js" `
        -WorkingDirectory $root -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $outLog -RedirectStandardError "$outLog.err"

Set-Content -Path $pidFile -Value $p.Id -Encoding ascii

Write-Host ""
Write-Host "  Collector running continuously. PID $($p.Id)." -ForegroundColor Green
Write-Host "  Rounds back to back: crawl for emails, advance directories,"
Write-Host "  import $OsmCountries countries from OpenStreetMap ($OsmParallel at once), publish."
Write-Host ""
Write-Host "  Watch    : Get-Content $root\data\daemon.log -Wait -Tail 5"
Write-Host "  Progress : node daemon.js status"
Write-Host "  Stop     : powershell -File start-collector.ps1 -Stop"
Write-Host ""
