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
    # Four, matching the daemon's own default. It used to say twelve here,
    # which quietly overrode the daemon whatever the daemon thought: twelve
    # countries sharing one slice is seconds each, an Overpass query against
    # a country takes longer than that, and every country was started and
    # none finished. Anything set here wins, so it has to agree.
    [int]$OsmCountries  = 4,
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

        # Is it running the code that is on disk? A collector reads daemon.js
        # once and then executes that copy for days, so a pulled change sits
        # there doing nothing and everything still looks healthy. This is the
        # question to ask when a new engine never appears in status.json.
        $newest = $null
        $src = @((Join-Path $root "daemon.js"), (Join-Path $root "publish.js"))
        $src += (Get-ChildItem (Join-Path $root "lib") -Filter *.js -ErrorAction SilentlyContinue |
                 ForEach-Object { $_.FullName })
        foreach ($f in $src) {
            if (Test-Path $f) {
                $t = (Get-Item $f).LastWriteTime
                if ($null -eq $newest -or $t -gt $newest) { $newest = $t }
            }
        }
        if ($newest -and $newest -gt $p.StartTime) {
            Write-Host "  Running OLD CODE: the files on disk were written $($newest.ToString('s'))," -ForegroundColor Yellow
            Write-Host "  after this process started. Restart to pick them up:" -ForegroundColor Yellow
            Write-Host "    powershell -File start-collector.ps1 -Stop; powershell -File start-collector.ps1" -ForegroundColor Yellow
        } else {
            Write-Host "  Running the code that is on disk." -ForegroundColor Green
        }

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

# Which node. Node 24 ships undici 7, whose HTTP/1 parser kills the whole
# process with an uncatchable AssertionError (assert(!this.paused)) when a
# server closes the socket while a response body sits unread - which the
# crawl does on every non-OK or non-HTML answer. Leo, 2026-09-03: one such
# crash took the collector down mid-round, and the v7 backport of the fix
# was abandoned (nodejs/undici#5360, fixed in undici 8.4.1 / Node 26). So
# when the node on PATH is older than 26, prefer the newest 26+ that
# nvm-windows has installed, without touching the machine's default.
$node = (Get-Command node).Source
$nodeMajor = [int](((& $node --version) -replace '^v','') -split '\.')[0]
# nvm's root: NVM_HOME where the shell has it, otherwise the folder the
# nodejs symlink points into (C:\nvm4w\nodejs -> C:\ProgramData\nvm\vN).
$nvmRoot = $env:NVM_HOME
if (-not $nvmRoot) {
    $target = (Get-Item (Split-Path $node) -Force -ErrorAction SilentlyContinue).Target | Select-Object -First 1
    if ($target) { $nvmRoot = Split-Path $target }
}
if ($nodeMajor -lt 26 -and $nvmRoot -and (Test-Path $nvmRoot)) {
    $newer = Get-ChildItem $nvmRoot -Directory -Filter 'v*' |
        Where-Object { $_.Name -match '^v(\d+)\.' -and [int]$Matches[1] -ge 26 -and (Test-Path (Join-Path $_.FullName 'node.exe')) } |
        Sort-Object { [version]($_.Name.TrimStart('v')) } -Descending |
        Select-Object -First 1
    if ($newer) {
        $node = Join-Path $newer.FullName 'node.exe'
        Write-Host "  Using $node (the node on PATH is v$nodeMajor, whose undici crashes the collector)." -ForegroundColor Yellow
    } else {
        Write-Host "  Warning: node v$nodeMajor on PATH and no Node 26+ under $nvmRoot - undici 7 can crash the collector; the watchdog restarts it." -ForegroundColor Yellow
    }
}
$p = Start-Process -FilePath $node -ArgumentList "daemon.js" `
        -WorkingDirectory $root -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $outLog -RedirectStandardError "$outLog.err"

Set-Content -Path $pidFile -Value $p.Id -Encoding ascii

Write-Host ""
Write-Host "  Collector running continuously. PID $($p.Id)." -ForegroundColor Green
Write-Host "  Rounds back to back: crawl for emails, read places from Overture Maps,"
Write-Host "  import $OsmCountries countries from OpenStreetMap ($OsmParallel at once), publish."
Write-Host ""
Write-Host "  Watch    : Get-Content $root\data\daemon.log -Wait -Tail 5"
Write-Host "  Progress : node daemon.js status"
Write-Host "  Stop     : powershell -File start-collector.ps1 -Stop"
Write-Host ""
