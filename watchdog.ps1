<#
    watchdog.ps1 - keep the continuous collector alive and publishing

    Leo, 2026-08-14: away for days, and the public page must never freeze.
    This guard runs every fifteen minutes from a Scheduled Task and does
    exactly three things:

      - collector not running       -> start it
      - running but not publishing  -> restart it
      - running code older than the
        code on disk                -> restart it onto the new code

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

<#
    Third kind of unhealthy, and the one that hides best: alive, publishing,
    and running code that no longer exists on disk.

    Node reads a file once, so a collector executes the daemon.js it was
    started with for as long as it stays up. publish.js does a hard reset
    onto the remote whenever the branch has moved, which is how a change
    reaches this machine - so a fix lands on disk, correctly, and is then
    ignored for days. That is exactly what happened to the Overture
    importer: merged, pulled, written to disk, and absent from every
    status.json the collector published, because the process writing them
    had never heard of it. Nothing above catches that. The process is not
    dead and it is not wedged. It is old.

    This script is the only part of the system that is re-read from disk on
    a schedule - the Scheduled Task starts a fresh PowerShell every fifteen
    minutes - so it is the only place a check like this can live and still
    take effect without somebody logging in to restart something.

    Comparing file times against the process start time needs no state and
    cannot loop: after the restart the process is newer than the files.
#>
$oldCode = $false
$newestSrc = $null
if ($p) {
    $src = @((Join-Path $root "daemon.js"), (Join-Path $root "publish.js"))
    $src += (Get-ChildItem (Join-Path $root "lib") -Filter *.js -ErrorAction SilentlyContinue |
             ForEach-Object { $_.FullName })
    foreach ($f in $src) {
        if (Test-Path $f) {
            $t = (Get-Item $f).LastWriteTime
            if ($null -eq $newestSrc -or $t -gt $newestSrc) { $newestSrc = $t }
        }
    }
    try {
        # The three minutes are anti-thrash, not caution: a collector that
        # has only just started is left alone, so a restart can never chase
        # its own tail if something on this machine keeps rewriting sources.
        $upMin = ((Get-Date) - $p.StartTime).TotalMinutes
        if ($newestSrc -and $newestSrc -gt $p.StartTime -and $upMin -gt 3) { $oldCode = $true }
    } catch {
        # Some processes refuse to give up StartTime. Not knowing is not a
        # reason to restart a healthy collector.
        $oldCode = $false
    }
}

if ($p -and -not $stale -and -not $oldCode) { return }   # healthy - do nothing, log nothing

if ($p -and $stale) {
    Note ("pid {0} alive but status.json is {1:n0} minutes old - restarting" -f $p.Id, $ageMin)
    powershell -ExecutionPolicy Bypass -File (Join-Path $root "start-collector.ps1") -Stop | Out-Null
    Start-Sleep -Seconds 5
}
elseif ($p -and $oldCode) {
    Note ("pid {0} started {1:s} but the code on disk was written {2:s} - restarting onto it" -f `
          $p.Id, $p.StartTime, $newestSrc)
    powershell -ExecutionPolicy Bypass -File (Join-Path $root "start-collector.ps1") -Stop | Out-Null
    Start-Sleep -Seconds 5
}
if (-not $p) { Note "collector not running - starting" }

powershell -ExecutionPolicy Bypass -File (Join-Path $root "start-collector.ps1") | Out-Null
Note "started"
