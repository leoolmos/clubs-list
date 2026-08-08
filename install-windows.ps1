<#
    install-windows.ps1 - run the collector once an hour, for good

    Registers a Windows Scheduled Task that runs one collection round every
    hour and pushes the result, so the published page keeps filling up
    without anyone starting anything.

        powershell -ExecutionPolicy Bypass -File install-windows.ps1
        powershell -ExecutionPolicy Bypass -File install-windows.ps1 -Remove

    The task runs as the current user, only while logged on, and does not
    wake a sleeping machine. A round that finds nothing new costs a minute
    of network and stops.

    Run it from the folder you want the collector to live in permanently.
    A git worktree is not that folder - those get deleted.
#>

param(
    [switch]$Remove,
    [string]$TaskName = "RacketClubCollector",
    [int]$Minutes = 60
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$node = (Get-Command node).Source

if ($Remove) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "  Removed the scheduled task '$TaskName'. Nothing else changed." -ForegroundColor Yellow
        Write-Host "  Collected data stays in $root\data"
    } else {
        Write-Host "  No task called '$TaskName' - nothing to remove."
    }
    return
}

if (-not (Test-Path (Join-Path $root "daemon.js"))) {
    throw "daemon.js is not in $root. Run this from the collector folder."
}

# A worktree is temporary; a task pointing into one breaks the moment it is
# pruned, and it fails silently once an hour after that.
if ($root -match "\\\.claude\\worktrees\\") {
    throw "$root is a git worktree, which gets deleted. Clone the repository somewhere permanent and run this there."
}

Write-Host ""
Write-Host "  Collector folder : $root"
Write-Host "  Node             : $node"
Write-Host "  Every            : $Minutes minutes"
Write-Host ""

$action = New-ScheduledTaskAction -Execute $node -Argument "daemon.js once" -WorkingDirectory $root

# Repeat forever, starting five minutes from now so the first run does not
# collide with whatever is being set up right now.
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) `
             -RepetitionInterval (New-TimeSpan -Minutes $Minutes)

$settings = New-ScheduledTaskSettingsSet `
              -StartWhenAvailable `
              -DontStopIfGoingOnBatteries `
              -AllowStartIfOnBatteries `
              -ExecutionTimeLimit (New-TimeSpan -Minutes 55) `
              -MultipleInstances IgnoreNew

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "  (replacing the existing task)"
}

Register-ScheduledTask -TaskName $TaskName `
    -Action $action -Trigger $trigger -Settings $settings `
    -Description "Collects racket club contacts and publishes clubs.json to GitHub Pages" | Out-Null

Write-Host "  Done. The collector runs every $Minutes minutes from now on." -ForegroundColor Green
Write-Host ""
Write-Host "  Watch it        : Get-ScheduledTaskInfo -TaskName $TaskName"
Write-Host "  Run it now      : Start-ScheduledTask -TaskName $TaskName"
Write-Host "  Progress        : node daemon.js status"
Write-Host "  Log             : $root\data\daemon.log"
Write-Host "  Stop it         : powershell -File install-windows.ps1 -Remove"
Write-Host ""
