<#
    watchdog.ps1 - keep the continuous collector alive and publishing

    Leo, 2026-08-14: away for days, and the public page must never freeze.
    This guard runs every fifteen minutes from a Scheduled Task and does
    exactly two things:

      - collector not running       -> start it
      - running but not publishing  -> restart it

    "Not publishing" is read from status.json in this folder: a healthy
    round rewrites it every few minutes, so a copy older than 45 minutes
    means the daemon is wedged, however alive its process looks.

    It never runs a second collector: start-collector.ps1 refuses when one
    is already up, and the daemon holds its own lock besides. A healthy
    check exits silently - data\watchdog.log only records interventions.

    Install (once):  powershell -ExecutionPolicy Bypass -File watchdog.ps1 -Install
#>

param([switch]$Install)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

if ($Install) {
    $action = New-ScheduledTaskAction -Execute "powershell.exe" `
        -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$root\watchdog.ps1`""
    $atLogon = New-ScheduledTaskTrigger -AtLogOn
    $every15 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
        -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 3650)
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
    Register-ScheduledTask -TaskName "ClubsCollectorWatchdog" -Action $action `
        -Trigger $atLogon, $every15 -Settings $settings -Force | Out-Null
    Write-Host "  Watchdog installed: every 15 minutes and at logon." -ForegroundColor Green
    return
}

function Note($m) {
    $log = Join-Path $root "data\watchdog.log"
    Add-Content -Path $log -Value ("{0}  {1}" -f (Get-Date -Format s), $m)
}

# The collector process, judged the same way start-collector.ps1 judges it
$p = $null
$pidFile = Join-Path $root "data\collector.pid"
if (Test-Path $pidFile) {
    $id = (Get-Content $pidFile -Raw).Trim()
    if ($id) {
        $q = Get-Process -Id ([int]$id) -ErrorAction SilentlyContinue
        if ($q -and $q.ProcessName -eq 'node') { $p = $q }
    }
}

# Publishing health: a live round rewrites status.json every few minutes
$staleMinutes = 45
$stale = $true
$ageMin = -1
$statusFile = Join-Path $root "status.json"
if (Test-Path $statusFile) {
    $ageMin = ((Get-Date) - (Get-Item $statusFile).LastWriteTime).TotalMinutes
    $stale = $ageMin -gt $staleMinutes
}

if ($p -and -not $stale) { return }   # healthy - do nothing, log nothing

if ($p -and $stale) {
    Note ("pid {0} alive but status.json is {1:n0} minutes old - restarting" -f $p.Id, $ageMin)
    powershell -ExecutionPolicy Bypass -File (Join-Path $root "start-collector.ps1") -Stop | Out-Null
    Start-Sleep -Seconds 5
}
if (-not $p) { Note "collector not running - starting" }

powershell -ExecutionPolicy Bypass -File (Join-Path $root "start-collector.ps1") | Out-Null
Note "started"
