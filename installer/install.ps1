<#
.SYNOPSIS
  Install or upgrade NoteControl on this Windows machine.

.DESCRIPTION
  Installs the server as a Windows service (NoteControlServer) running
  as LocalSystem with auto-start, registers the tray app to launch at
  login for every user (HKLM Run), and creates an Add/Remove Programs
  entry. Re-running this script over an existing install performs an
  in-place upgrade: stops the service, replaces binaries, restarts.
  Vault data under C:\ProgramData\NoteControl\NotesData is never
  touched.

.PARAMETER InstallDir
  Where the binaries go. Defaults to "C:\Program Files\NoteControl".
  Must be writable by Administrators (it will be -- this is the
  whole point of running elevated).

.PARAMETER DataRoot
  Where notes and server state live. Defaults to
  "C:\ProgramData\NoteControl\NotesData". The installer just makes
  sure the folder exists; it doesn't touch existing contents. The
  server reads this path from appsettings.json, which already points
  at the same default.

.PARAMETER ServiceName
  Windows service name. Defaults to "NoteControlServer". Hardcoded
  in the tray (Server\ServerController.cs); only change this if you
  know you want to keep them in sync.

.PARAMETER Port
  Default port the server listens on. Used only for the post-install
  health probe; the live port comes from {DataRoot}\.server\config.json
  (overlaid on appsettings.json) and the URL the server publishes to
  {DataRoot}\.server\server.url (Ship 43). Default 8080 matches
  appsettings.json.

.PARAMETER NoTrayLaunch
  Switch -- skip launching the tray for the current user at the end
  of the install. The HKLM Run entry is still created, so the tray
  will launch on next login. Useful for unattended installs.

.PARAMETER Silent
  Switch -- suppress the "Press Enter to exit" pause at the end.
  For scripted use.

.EXAMPLE
  # Standard install / upgrade. Run from the dist folder.
  .\installer\install.ps1

.EXAMPLE
  # Install to a custom location.
  .\installer\install.ps1 -InstallDir "D:\Apps\NoteControl"

.NOTES
  Run as Administrator. The script self-checks and exits with
  guidance if you forget.

  Expected layout (the dist folder produced by publish.ps1 that
  contains this script):
    .\installer\install.ps1        (this file)
    .\installer\uninstall.ps1
    .\server\NoteControl.Server.exe
    .\tray\NoteControl.Tray.exe
    .\VERSION.txt
#>

[CmdletBinding()]
param(
    [string] $InstallDir   = "$env:ProgramFiles\NoteControl",
    [string] $DataRoot     = "$env:ProgramData\NoteControl\NotesData",
    [string] $ServiceName  = "NoteControlServer",
    [int]    $Port         = 8080,
    [switch] $NoTrayLaunch,
    [switch] $Silent
)

$ErrorActionPreference = 'Stop'

# Each major action gets logged AS WELL AS shown on screen, so a user
# who runs this and then asks "what happened?" can read install.log
# next to the binaries afterwards. Console-only errors during early
# bootstrapping are fine -- nothing mutated yet at that point.
#
# Ship 67: streaming. Pre-Ship-67, log lines were buffered in memory
# and only persisted by Set-Content at the very end of the script.
# If the script crashed mid-way (which happened on a botched in-tray
# update -- tray\ folder ended up missing, log file untouched), every
# log line went to /dev/null and the user was left staring at a stale
# install.log from a previous run, with no clue which step failed.
#
# Now: lines still go into $global:LogLines (so the final summary
# write works the same), but if $global:LogFile is set we also
# append to disk on every call. $global:LogFile gets pointed at
# install.log as soon as $InstallDir exists -- which is well before
# anything risky like Stop-Service or Copy-Item runs. Pre-bootstrap
# lines (the few before $InstallDir is created) get caught up by
# the "flush whatever isn't yet on disk" pass at the end, OR by an
# explicit Flush-Log call from a catch block.
$global:LogLines     = New-Object System.Collections.Generic.List[string]
$global:LogFile      = $null
$global:LogFlushedTo = 0   # how many entries of $LogLines have been written to $LogFile

function Write-Step {
    param([string]$Message, [ConsoleColor]$Color = [ConsoleColor]::White)
    Write-Host "  $Message" -ForegroundColor $Color
    $line = "[$(Get-Date -Format 'HH:mm:ss')] $Message"
    $global:LogLines.Add($line)
    if ($global:LogFile) {
        # Append-only; don't fight the file system if it's
        # transiently locked (av scanning Program Files etc.).
        try {
            Add-Content -LiteralPath $global:LogFile -Value "  $line" -Encoding UTF8 -ErrorAction Stop
            $global:LogFlushedTo = $global:LogLines.Count
        } catch {
            # Best-effort log; we'd rather lose a log line than
            # blow up an install because of an antivirus race.
            # The end-of-script flush will retry the whole tail.
        }
    }
}
function Write-Section {
    param([string]$Title)
    Write-Host ""
    Write-Host "==> $Title" -ForegroundColor Cyan
    $global:LogLines.Add("")
    $global:LogLines.Add("==> $Title")
    if ($global:LogFile) {
        try {
            Add-Content -LiteralPath $global:LogFile -Value @("", "==> $Title") -Encoding UTF8 -ErrorAction Stop
            $global:LogFlushedTo = $global:LogLines.Count
        } catch { }
    }
}

# Flush any in-memory log entries that haven't yet been written to
# the log file. Called from catch blocks and at the end of the
# script. Idempotent -- safe to call multiple times.
function Flush-Log {
    if (-not $global:LogFile) { return }
    if ($global:LogFlushedTo -ge $global:LogLines.Count) { return }
    $tail = $global:LogLines.GetRange(
        $global:LogFlushedTo,
        $global:LogLines.Count - $global:LogFlushedTo)
    try {
        Add-Content -LiteralPath $global:LogFile -Value $tail -Encoding UTF8 -ErrorAction Stop
        $global:LogFlushedTo = $global:LogLines.Count
    } catch {
        # If we can't even append at flush time, there's nothing
        # more we can do -- the screen output is the user's only
        # remaining record.
    }
}

# ---------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------
Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
Write-Host " NoteControl installer" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan

# Admin check. Without this, every later step silently fails or
# gives misleading errors (sc.exe complains about access denied,
# Copy-Item to Program Files fails, etc.).
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal   = New-Object Security.Principal.WindowsPrincipal($currentUser)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host ""
    Write-Host "ERROR: This script must run as Administrator." -ForegroundColor Red
    Write-Host "  Right-click PowerShell -> 'Run as administrator', then re-run." -ForegroundColor Yellow
    Write-Host ""
    exit 1
}

# Locate the dist folder (the parent of the installer\ folder this
# script lives in). Resolve absolute so log paths look sensible.
$ScriptDir = $PSScriptRoot
$DistRoot  = Split-Path -Parent $ScriptDir
$ServerSrc = Join-Path $DistRoot "server"
$TraySrc   = Join-Path $DistRoot "tray"
$VersionFile = Join-Path $DistRoot "VERSION.txt"

# Verify dist layout is sane. Bailing out here is much better than
# half-installing because someone ran the bare uninstaller from
# a Downloads folder or a non-published checkout.
if (-not (Test-Path -LiteralPath (Join-Path $ServerSrc "NoteControl.Server.exe"))) {
    Write-Host ""
    Write-Host "ERROR: Can't find server\NoteControl.Server.exe relative to this script." -ForegroundColor Red
    Write-Host "  Looking under: $ServerSrc" -ForegroundColor Yellow
    Write-Host "  Run this script from a published dist folder produced by publish.ps1." -ForegroundColor Yellow
    Write-Host ""
    exit 1
}
if (-not (Test-Path -LiteralPath (Join-Path $TraySrc "NoteControl.Tray.exe"))) {
    Write-Host ""
    Write-Host "ERROR: Can't find tray\NoteControl.Tray.exe relative to this script." -ForegroundColor Red
    Write-Host "  Looking under: $TraySrc" -ForegroundColor Yellow
    Write-Host ""
    exit 1
}

# Read the version (best-effort; not critical for install logic).
$Version = "(unknown)"
if (Test-Path -LiteralPath $VersionFile) {
    $vline = (Get-Content $VersionFile | Where-Object { $_ -match '^Version:' } | Select-Object -First 1)
    if ($vline) { $Version = ($vline -replace '^Version:\s*', '').Trim() }
}

Write-Host ""
Write-Host "  Source:       $DistRoot"
Write-Host "  Version:      $Version"
Write-Host "  Install dir:  $InstallDir"
Write-Host "  Data root:    $DataRoot"
Write-Host "  Service:      $ServiceName"
Write-Host ""

# Detect existing install -- decides whether this is a fresh install
# or an in-place upgrade. The decision affects whether we stop the
# old service first, etc.
$service     = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
$isUpgrade   = ($null -ne $service) -or (Test-Path -LiteralPath $InstallDir)
if ($isUpgrade) {
    Write-Host "  Detected existing install -- will perform in-place upgrade." -ForegroundColor Yellow
} else {
    Write-Host "  Fresh install." -ForegroundColor Green
}

# ---------------------------------------------------------------
# Stop service + tray (if upgrading)
# ---------------------------------------------------------------
Write-Section "Stopping running components"

if ($service) {
    if ($service.Status -ne 'Stopped') {
        Write-Step "Stopping service '$ServiceName' (status was $($service.Status))..."
        try {
            Stop-Service -Name $ServiceName -Force -ErrorAction Stop
            # Wait for true Stopped state -- Stop-Service returns once
            # the SCM acknowledges the stop request, which can be
            # before the process has actually exited and released its
            # file locks.
            $deadline = (Get-Date).AddSeconds(30)
            while ((Get-Date) -lt $deadline) {
                $s = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
                if (-not $s -or $s.Status -eq 'Stopped') { break }
                Start-Sleep -Milliseconds 250
            }
            Write-Step "  Service stopped." Green
        } catch {
            Write-Step "  Could not stop service cleanly: $($_.Exception.Message)" Yellow
            Write-Step "  Continuing -- file copy may fail if the .exe is still locked." Yellow
        }
    } else {
        Write-Step "Service already stopped."
    }
}

# Kill tray. Any installation that replaces tray.exe must do this
# first, otherwise Copy-Item gets ACCESS DENIED on the live binary.
#
# Ship 67: the previous "Stop-Process | Start-Sleep 500" was fire-
# and-forget. Stop-Process returns when the SCM has been told to
# kill the process, NOT when the process has actually exited.
# 500ms isn't always enough on a busy box, especially when tray.exe
# is mid-shutdown disposing H.NotifyIcon resources. The result was
# a botched in-tray update where Copy-Item failed on the still-
# locked tray.exe, the script crashed silently (no streaming log
# pre-Ship-67), and the user ended up with a missing tray\ folder.
# Now we poll Get-Process until either the process is gone or 15s
# passes. If it's still alive at 15s, log loudly and continue --
# the copy step's try/catch will surface the file-lock error in
# the (now persisted) log if it does fail.
$trayProcs = Get-Process -Name "NoteControl.Tray" -ErrorAction SilentlyContinue
if ($trayProcs) {
    Write-Step "Stopping tray ($($trayProcs.Count) process(es))..."
    $trayProcs | Stop-Process -Force -ErrorAction SilentlyContinue

    $trayDeadline = (Get-Date).AddSeconds(15)
    $trayGone = $false
    while ((Get-Date) -lt $trayDeadline) {
        $still = Get-Process -Name "NoteControl.Tray" -ErrorAction SilentlyContinue
        if (-not $still) { $trayGone = $true; break }
        Start-Sleep -Milliseconds 250
    }
    if ($trayGone) {
        Write-Step "  Tray stopped (verified gone)." Green
    } else {
        Write-Step "  Tray STILL running after 15s -- copy may fail." Yellow
        Write-Step "  This is unusual; check Task Manager for stuck NoteControl.Tray." Yellow
    }
}

# ---------------------------------------------------------------
# Copy files
# ---------------------------------------------------------------
Write-Section "Copying files to $InstallDir"

# Make sure the destination exists.
if (-not (Test-Path -LiteralPath $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    Write-Step "Created $InstallDir"
}

# Ship 67: from this point on, every Write-Step / Write-Section
# also appends to install.log immediately. We rotate the file
# (truncate + write header) so the previous run's log is replaced
# rather than appended to -- otherwise a chain of failed installs
# leaves a Frankenstein log that's hard to read.
$global:LogFile = Join-Path $InstallDir "install.log"
$logHeader = @(
    "NoteControl install log",
    "Run at:  $(Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz')",
    "Version: $Version",
    "Mode:    $(if ($isUpgrade) { 'upgrade' } else { 'fresh install' })",
    "Source:  $DistRoot",
    "Target:  $InstallDir",
    "Data:    $DataRoot",
    "User:    $env:USERDOMAIN\$env:USERNAME",
    "----------------------------------------"
)
try {
    # Set-Content (not Add-Content) so the file is truncated/created.
    Set-Content -LiteralPath $global:LogFile -Value $logHeader -Encoding UTF8 -ErrorAction Stop
    # Now flush the buffered lines from before this point (admin
    # check, dist verification, service detect, stop-service, kill-
    # tray) -- they accumulated in $global:LogLines while $LogFile
    # was still null.
    Flush-Log
    Write-Step "Streaming log to $global:LogFile" Green
} catch {
    # If we can't open the log at all (read-only volume? AV?),
    # disable streaming and fall back to the original behaviour
    # (one big write at the end).
    Write-Step "Could not open install.log for streaming: $($_.Exception.Message)" Yellow
    Write-Step "Logs will only be written if the install completes." Yellow
    $global:LogFile = $null
}

# For an upgrade, wipe the SUBFOLDERS we own (server\ and tray\) but
# leave install.log around so we have continuity. We don't blanket-
# delete $InstallDir because the user might have things alongside
# (custom appsettings overrides, etc. -- though we don't support
# that yet, defensive is cheap).
foreach ($sub in @("server", "tray")) {
    $target = Join-Path $InstallDir $sub
    if (Test-Path -LiteralPath $target) {
        Write-Step "Removing old $sub\ ..."
        # Suppress errors on locked files so we surface a clearer
        # error in the copy step below if something is still held.
        Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# Ship 67: file copy is wrapped in try/catch + Flush-Log so a copy
# failure (most likely cause: stale file lock on tray.exe from a
# tray that didn't fully release its handles) writes the log to
# disk before the script terminates. Pre-Ship-67, $ErrorActionPreference=Stop
# turned a Copy-Item failure into a script-fatal exception that
# never reached the end-of-script log write -- the user was left
# with a stale install.log and no clue what failed.
try {
    Write-Step "Copying server\ ..."
    Copy-Item -Path $ServerSrc -Destination $InstallDir -Recurse -Force -ErrorAction Stop
    Write-Step "  server\ copied." Green
} catch {
    Write-Step "ERROR copying server\: $($_.Exception.Message)" Red
    Flush-Log
    throw
}

try {
    Write-Step "Copying tray\ ..."
    Copy-Item -Path $TraySrc -Destination $InstallDir -Recurse -Force -ErrorAction Stop
    Write-Step "  tray\ copied." Green
} catch {
    Write-Step "ERROR copying tray\: $($_.Exception.Message)" Red
    Write-Step "  Most likely cause: tray.exe was still locked when the copy started." Yellow
    Write-Step "  Check if a NoteControl.Tray process is still running:" Yellow
    Write-Step "    Get-Process NoteControl.Tray" Yellow
    Flush-Log
    throw
}

# Copy VERSION.txt and the uninstaller alongside, so they're available
# without re-downloading the whole dist.
if (Test-Path -LiteralPath $VersionFile) {
    Copy-Item -LiteralPath $VersionFile -Destination $InstallDir -Force
    Write-Step "Copied VERSION.txt"
}
$uninstallSrc = Join-Path $ScriptDir "uninstall.ps1"
if (Test-Path -LiteralPath $uninstallSrc) {
    Copy-Item -LiteralPath $uninstallSrc -Destination $InstallDir -Force
    Write-Step "Copied uninstall.ps1"
}

# ---------------------------------------------------------------
# Tray autostart (HKLM Run)
# ---------------------------------------------------------------
# Ship 96: moved earlier in the script. Was previously at the end,
# AFTER service-config + DACL + start-service + health-probe. Any
# failure in those steps left HKLM\Run untouched -- which is fine
# the FIRST time you install, but on an upgrade meant the existing
# entry kept pointing at the previous tray.exe even if the upgrade
# moved the install. Worse: when an upgrade installs to a fresh
# location and a later step throws, HKLM\Run still pointed at the
# OLD path that the upgrade just deleted. On next sign-in,
# Windows tried to launch a non-existent exe and silently dropped
# the autostart. The user reported "tray never starts up again
# without PC reboot" -- in fact next-sign-in didn't work because
# the registry pointed at a missing file.
#
# Now: write HKLM\Run as soon as both binaries are confirmed
# on disk. This way every later failure (service registration,
# DACL update, service start, health probe, tray launch) leaves
# autostart in a working state. On the next sign-in / reboot the
# tray launches from the freshly-installed exe.
Write-Section "Registering tray autostart"

$runKey   = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run'
$runValue = 'NoteControlTray'
$trayExe  = Join-Path $InstallDir "tray\NoteControl.Tray.exe"
# Quote the path because Program Files contains a space.
$trayCmd  = '"' + $trayExe + '"'

# Verify the exe is actually on disk before writing the registry
# entry. If it isn't, something went wrong above; we'd rather
# surface that here than write a broken HKLM\Run value.
if (-not (Test-Path -LiteralPath $trayExe)) {
    Write-Step "  ERROR: $trayExe is missing after copy. Aborting." Red
    Flush-Log
    throw "Tray executable not found at expected path: $trayExe"
}

if (-not (Test-Path -LiteralPath $runKey)) {
    # Should always exist on a sane Windows install; create defensively.
    New-Item -Path $runKey -Force | Out-Null
}
Set-ItemProperty -Path $runKey -Name $runValue -Value $trayCmd -Type String
Write-Step "  HKLM\...\Run\$runValue = $trayCmd" Green

# ---------------------------------------------------------------
# Ensure data root exists
# ---------------------------------------------------------------
Write-Section "Preparing data root"

# We deliberately don't recursively chmod / take ownership / nuke
# anything here. The server runs as LocalSystem, which already has
# full access to ProgramData. If a user somehow has unusual ACLs,
# fixing them automatically would mask actual problems we'd want
# to know about.
if (-not (Test-Path -LiteralPath $DataRoot)) {
    New-Item -ItemType Directory -Path $DataRoot -Force | Out-Null
    Write-Step "Created $DataRoot"
} else {
    Write-Step "Data root already exists at $DataRoot (left untouched)."
}

# Logs folder lives next to NotesData, configured by appsettings.
$logsDir = Join-Path (Split-Path -Parent $DataRoot) "logs"
if (-not (Test-Path -LiteralPath $logsDir)) {
    New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
    Write-Step "Created $logsDir"
}

# ---------------------------------------------------------------
# Service registration
# ---------------------------------------------------------------
Write-Section "Configuring Windows service"

$serverExe = Join-Path $InstallDir "server\NoteControl.Server.exe"

# sc.exe is finicky about argument quoting. The binPath= value
# wants the path inside quotes if it contains spaces, AND sc.exe's
# command grammar requires a SPACE after each "=" sign (yes, that
# space is intentional and significant -- "binPath= value", not
# "binPath=value"). PowerShell's call operator + an args array
# handles the quoting right; native sc.exe sees each array element
# as one argv entry, and we let it merge "binPath=" + " " + "..."
# itself by passing them as separate arguments.
$svcArgs = @()

if ($null -eq $service) {
    Write-Step "Creating service '$ServiceName' ..."
    $svcArgs = @(
        'create', $ServiceName,
        'binPath=', $serverExe,
        'DisplayName=', 'NoteControl Server',
        'start=', 'auto'
    )
    & sc.exe @svcArgs | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "sc.exe create returned $LASTEXITCODE"
    }
} else {
    Write-Step "Service exists -- updating binPath ..."
    $svcArgs = @(
        'config', $ServiceName,
        'binPath=', $serverExe,
        'start=', 'auto'
    )
    & sc.exe @svcArgs | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "sc.exe config returned $LASTEXITCODE"
    }
}

# Description -- shows in services.msc.
& sc.exe description $ServiceName "NoteControl notes server. Hosts the API + frontend on a configurable port." | Out-Null

# Failure recovery: restart on each of the first three failures
# after a 60-second delay. Fourth failure does nothing (avoids
# infinite-loop crash spam).
& sc.exe failure $ServiceName 'reset=' '86400' 'actions=' 'restart/60000/restart/60000/restart/60000' | Out-Null

Write-Step "  Service configured." Green

# ---------------------------------------------------------------
# Grant Authenticated Users start/stop on the service (Ship 66)
# ---------------------------------------------------------------
# By default a Windows service created by `sc create` only lets
# Administrators start/stop it. The tray runs un-elevated under the
# user's interactive token, which means clicking "Restart server"
# in the tray fails with exit-code-5 (Access denied) on every
# install we've tested.
#
# Two ways to fix that: prompt for UAC every time, or widen the
# service's DACL so normal users can start/stop it. We do both --
# this widens the DACL so the common case (one user on this
# machine, signed in, owns the data anyway) is silent. The tray
# still has a UAC fallback for installs done before this script,
# and for any case where this step somehow didn't take.
#
# Mechanism:
#   1. Read the existing SDDL via `sc sdshow`.
#   2. If our ACE is already there, skip (idempotent).
#   3. Otherwise insert `(A;;RPWPDTLO;;;AU)` into the DACL --
#      that grants Authenticated Users:
#        RP = SERVICE_START
#        WP = SERVICE_STOP
#        DT = SERVICE_PAUSE_CONTINUE
#        LO = SERVICE_INTERROGATE
#      Read access (LCRRC etc.) is already granted to AU by the
#      default service DACL.
#   4. Write back via `sc sdset`.
#
# The ACE is appended INSIDE the D: section (DACL) -- after the
# last existing ACE, before any S: section (SACL) if present.
# Service SDDLs in the wild rarely have a SACL; we handle it
# anyway so we don't corrupt the descriptor on edge-case
# machines.
Write-Section "Granting service start/stop to Authenticated Users"

$desiredAce = '(A;;RPWPDTLO;;;AU)'
$sdshow     = & sc.exe sdshow $ServiceName 2>&1 | Out-String
$sdshow     = $sdshow.Trim()

if ([string]::IsNullOrWhiteSpace($sdshow)) {
    Write-Step "  sc sdshow returned nothing -- skipping DACL update." Yellow
    Write-Step "  Tray will fall back to UAC prompt for start/stop." Yellow
} elseif ($sdshow -like "*$desiredAce*") {
    Write-Step "  DACL already grants AU start/stop -- skipping." Green
} else {
    # Find the boundary between D: (DACL) and S: (SACL, if any).
    # Format examples:
    #   D:(A;;...)(A;;...)             <-- no SACL
    #   D:(A;;...)(A;;...)S:(AU;...)   <-- with SACL
    # We need to insert our ACE at the end of the D: section.
    $sIndex = $sdshow.IndexOf('S:')
    if ($sIndex -ge 0) {
        $newSddl = $sdshow.Substring(0, $sIndex) + $desiredAce + $sdshow.Substring($sIndex)
    } else {
        $newSddl = $sdshow + $desiredAce
    }

    Write-Step "  Updating service DACL ..."
    # sc sdset wants the SDDL as a SINGLE positional arg. Quoting
    # is crucial because SDDL contains parens and semicolons that
    # PowerShell could otherwise misparse.
    $sdsetOut = & sc.exe sdset $ServiceName $newSddl 2>&1 | Out-String
    if ($LASTEXITCODE -eq 0) {
        Write-Step "  DACL updated. Tray can now start/stop without UAC." Green
    } else {
        # Don't throw -- the service still works, just the tray will
        # need UAC. Surface enough detail for the user to investigate
        # if they care.
        Write-Step "  sc.exe sdset returned $LASTEXITCODE." Yellow
        Write-Step "  Output: $($sdsetOut.Trim())" Yellow
        Write-Step "  Tray will fall back to UAC prompt for start/stop." Yellow
    }
}

# ---------------------------------------------------------------
# Start service + health check
# ---------------------------------------------------------------
Write-Section "Starting service"

Start-Service -Name $ServiceName -ErrorAction Stop

# Verify the service actually reached Running. Start-Service is
# fire-and-forget by default; on a heavily loaded box (or if the
# server crashes during startup) it can return without the SCM
# having transitioned the service to Running. Then the /health
# probe below times out, and the install log says "didn't respond
# in 30s" -- which is true but unhelpful.
#
# Ship 66 fix: poll Get-Service for up to 30 seconds, log the
# outcome explicitly. This was the missing-link bug that bit
# lightserver in the previous chat: install.ps1 said "service
# started" but the service was actually in StartPending and
# never reached Running.
$svcDeadline = (Get-Date).AddSeconds(30)
$svcReachedRunning = $false
while ((Get-Date) -lt $svcDeadline) {
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -eq 'Running') {
        $svcReachedRunning = $true
        break
    }
    Start-Sleep -Milliseconds 500
}
if ($svcReachedRunning) {
    Write-Step "  Service reached Running." Green
} else {
    $svcStatus = (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue).Status
    Write-Step "  Service didn't reach Running within 30s (current: $svcStatus)." Yellow
    Write-Step "  /health probe will follow but is likely to fail too." Yellow
    Write-Step "  Check $logsDir for server-side errors." Yellow
}

# Wait for /health. The server publishes its bound URL to
# {DataRoot}\.server\server.url (Ship 43) once Kestrel has bound.
# We probe that URL specifically, so reinstalls onto machines with
# an existing config that runs on a non-default port (e.g. 1234)
# don't get a false-negative "service didn't respond on 8080"
# from the installer (Ship 64).
#
# The file is written shortly AFTER service start, so we have a
# small bootstrap window where the file doesn't exist yet -- in
# that case we fall back to the parameter port. The deadline-based
# probe loop will retry, so eventually one of the two URLs gets
# a 200.
$serverUrlFile = Join-Path $DataRoot ".server\server.url"
$healthUrl = "http://127.0.0.1:$Port/health"
Write-Step "Probing /health ..."
$healthy = $false
$probedUrl = $healthUrl
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
    # Re-read server.url every iteration. Once the server publishes
    # it, we lock onto the real port and stop falling back.
    if (Test-Path -LiteralPath $serverUrlFile) {
        try {
            $serverUrlJson = Get-Content -LiteralPath $serverUrlFile -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($serverUrlJson.trayUrl) {
                # trayUrl is always loopback at the actual bound
                # port (per Ship 43), so it's the right thing to
                # probe from the installer.
                $probedUrl = ($serverUrlJson.trayUrl.TrimEnd('/')) + "/health"
            }
        } catch {
            # Malformed JSON or transient read; ignore and retry next loop.
        }
    }
    try {
        $r = Invoke-WebRequest -Uri $probedUrl -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        if ($r.StatusCode -eq 200) {
            $healthy = $true
            break
        }
    } catch {
        # Server not up yet; keep waiting.
    }
    Start-Sleep -Milliseconds 500
}
if ($healthy) {
    Write-Step "  Service is responding at $probedUrl." Green
} else {
    Write-Step "  Service didn't respond at $probedUrl within 30s." Yellow
    Write-Step "  Check logs at $logsDir for clues. Service is still registered." Yellow
}

# ---------------------------------------------------------------
# Tray autostart -- registration happens earlier (right after
# file copy succeeds) so that a failure in service-registration /
# DACL / health-probe doesn't leave HKLM\Run pointing at a stale
# path. See "Registering tray autostart" above.
# ---------------------------------------------------------------

# ---------------------------------------------------------------
# Add/Remove Programs entry
# ---------------------------------------------------------------
Write-Section "Registering uninstaller"

$uninstallKey = "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\NoteControl"
if (-not (Test-Path -LiteralPath $uninstallKey)) {
    New-Item -Path $uninstallKey -Force | Out-Null
}

$uninstallCmd = 'powershell.exe -ExecutionPolicy Bypass -NoProfile -File "' +
    (Join-Path $InstallDir "uninstall.ps1") + '"'

Set-ItemProperty -Path $uninstallKey -Name "DisplayName"     -Value "NoteControl"
Set-ItemProperty -Path $uninstallKey -Name "DisplayVersion"  -Value $Version
Set-ItemProperty -Path $uninstallKey -Name "Publisher"       -Value "NoteControl"
Set-ItemProperty -Path $uninstallKey -Name "InstallLocation" -Value $InstallDir
Set-ItemProperty -Path $uninstallKey -Name "UninstallString" -Value $uninstallCmd
Set-ItemProperty -Path $uninstallKey -Name "NoModify"        -Value 1 -Type DWord
Set-ItemProperty -Path $uninstallKey -Name "NoRepair"        -Value 1 -Type DWord
# Best-effort install-date (yyyymmdd, the format Add/Remove Programs expects).
Set-ItemProperty -Path $uninstallKey -Name "InstallDate"     -Value (Get-Date -Format 'yyyyMMdd')
Write-Step "  Add/Remove Programs entry written." Green

# ---------------------------------------------------------------
# Launch tray for the current user
# ---------------------------------------------------------------
if (-not $NoTrayLaunch) {
    Write-Section "Launching tray"

    # Ship 65: this got rewritten because Start-Process from inside
    # an elevated installer does NOT reliably launch a WPF app for
    # the interactive user. Two failure modes we hit:
    #
    #   1. -ErrorAction SilentlyContinue on Start-Process swallowed
    #      genuine launch failures, so the script printed
    #      "Tray launched" even when no process started.
    #   2. When triggered from the tray's in-app updater, the
    #      install.ps1 runs as elevated Administrator under the
    #      same identity that ran the tray. After install, the
    #      already-killed-old-tray needs to be replaced by a NEW
    #      tray running for the INTERACTIVE user -- which the
    #      elevated context doesn't reliably give us.
    #
    # The standard Windows pattern: schedule a one-shot Task
    # Scheduler task that runs as the interactive user, run it,
    # delete it. The Task Scheduler service does the
    # context-switching for us; tray ends up in the right session
    # under the right user with the right token.
    #
    # We try this path first, fall back to Start-Process if Task
    # Scheduler is unavailable for some reason. Either way we
    # check Get-Process afterwards to verify the launch actually
    # worked, instead of silently swallowing failures.

    $launched = $false
    $taskName = "NoteControlTrayLaunch_$(Get-Random -Maximum 99999)"

    # Resolve the interactive user. When install.ps1 is run from
    # the tray's in-app update, $env:USERNAME is whichever user
    # owns the tray process -- and that's exactly the user we want
    # to launch the new tray for. When install.ps1 is run by an
    # admin from PowerShell on a multi-user machine, this targets
    # that admin's session, which is also correct.
    $domain = $env:USERDOMAIN
    $user   = $env:USERNAME
    $fullUser = if ($domain) { "$domain\$user" } else { $user }

    try {
        # Build a no-window action that runs the tray.
        $action = New-ScheduledTaskAction -Execute $trayExe

        # InteractiveToken = run with the interactive user's token,
        # not as SYSTEM and not elevated. This is the magic.
        $principal = New-ScheduledTaskPrincipal `
            -UserId $fullUser `
            -LogonType Interactive `
            -RunLevel Limited

        $task = New-ScheduledTask -Action $action -Principal $principal

        # Register, run, then unregister. The task itself only
        # exists for ~1 second; we use it as a one-shot launcher.
        Register-ScheduledTask -TaskName $taskName -InputObject $task | Out-Null
        Start-ScheduledTask -TaskName $taskName

        # Give the tray ~3 seconds to actually start before we
        # delete the task and verify.
        Start-Sleep -Seconds 3

        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

        # Did it work?
        $proc = Get-Process NoteControl.Tray -ErrorAction SilentlyContinue
        if ($proc) {
            Write-Step "  Tray launched (PID $($proc.Id), session $($proc.SessionId))." Green
            $launched = $true
        }
    } catch {
        Write-Step "  Task Scheduler launch path failed: $($_.Exception.Message)" Yellow
        Write-Step "  Falling back to direct Start-Process..." Yellow
        # Best-effort cleanup in case the task was registered but
        # something downstream blew up.
        try {
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
        } catch {}
    }

    # Fallback: direct Start-Process. Same behaviour as Ship 48
    # had, but this time we VERIFY the launch worked instead of
    # swallowing the error.
    if (-not $launched) {
        try {
            Start-Process -FilePath $trayExe -ErrorAction Stop
            Start-Sleep -Seconds 2
            $proc = Get-Process NoteControl.Tray -ErrorAction SilentlyContinue
            if ($proc) {
                Write-Step "  Tray launched via fallback (PID $($proc.Id), session $($proc.SessionId))." Green
                $launched = $true
            }
        } catch {
            Write-Step "  Fallback Start-Process failed: $($_.Exception.Message)" Yellow
        }
    }

    if (-not $launched) {
        # Ship 96: when auto-launch fails, log enough detail that
        # the user (or whoever debugs this) can tell whether to
        # sign out, run the tray manually, or open a crash log.
        # Pre-Ship-96 the message was just "Could not auto-launch"
        # with no hint at WHY -- which left the user reporting
        # "tray never starts up again, had to reboot" without any
        # evidence trail.
        Write-Step "  Could not auto-launch the tray. Diagnostic check:" Yellow

        # Was the tray exe actually copied to disk?
        if (Test-Path -LiteralPath $trayExe) {
            Write-Step "    [OK]   tray.exe is on disk: $trayExe" Yellow
        } else {
            Write-Step "    [BAD]  tray.exe is MISSING at $trayExe" Red
            Write-Step "           Re-run install.ps1 to recover." Red
        }

        # Was the HKLM Run entry written? (Was done much earlier
        # in the script in Ship 96.)
        try {
            $runVal = Get-ItemProperty -Path $runKey -Name $runValue -ErrorAction Stop
            if ($runVal.$runValue -eq $trayCmd) {
                Write-Step "    [OK]   HKLM\...\Run\$runValue points at the new tray." Yellow
                Write-Step "           Next sign-in / reboot WILL launch the tray." Yellow
            } else {
                Write-Step "    [WARN] HKLM\...\Run\$runValue exists but points at: $($runVal.$runValue)" Yellow
                Write-Step "           Expected:                                       $trayCmd" Yellow
            }
        } catch {
            Write-Step "    [BAD]  HKLM\...\Run\$runValue is missing." Red
            Write-Step "           Tray will NOT launch on next sign-in. Re-run install.ps1." Red
        }

        # Did the tray maybe launch but crash immediately? Check
        # the crash log directory we know the tray writes to. If
        # there's a tray-crash-*.log file modified in the last 60
        # seconds, that's almost certainly what happened.
        #
        # Caveat: $env:LOCALAPPDATA inside this elevated context
        # is the ELEVATED user's profile. On a typical solo-dev
        # box that's the same person who runs the tray, so the
        # path matches. If install.ps1 was run by a different
        # admin via "Run as different user", we'd miss the
        # interactive user's crash dir -- not a regression
        # (pre-Ship-96 there was no crash log lookup at all),
        # just a known limitation of running elevated.
        $crashDir = Join-Path $env:LOCALAPPDATA 'NoteControl'
        if (Test-Path -LiteralPath $crashDir) {
            $recent = Get-ChildItem -LiteralPath $crashDir -Filter 'tray-crash-*.log' -ErrorAction SilentlyContinue |
                Where-Object { $_.LastWriteTime -gt (Get-Date).AddSeconds(-60) } |
                Sort-Object LastWriteTime -Descending |
                Select-Object -First 1
            if ($recent) {
                Write-Step "    [INFO] Recent tray crash log found:" Yellow
                Write-Step "           $($recent.FullName)" Yellow
                Write-Step "           The tray launched but crashed -- read the log for details." Yellow
            }
        }

        Write-Step "  To recover: sign out and back in, or double-click:" Yellow
        Write-Step "    $trayExe" Yellow
    }
} else {
    Write-Step "Skipping tray launch (-NoTrayLaunch). HKLM Run entry will launch on next login." Yellow
}

# ---------------------------------------------------------------
# Persist the install log inside the install dir
# ---------------------------------------------------------------
# Ship 67: the log has been streaming to disk since the "Copying
# files" section started (see $global:LogFile init above). Here we
# just flush anything still in the buffer and append a footer so
# the user can tell at a glance whether the install completed
# normally or was truncated mid-way.
#
# If $global:LogFile is null, we hit the fallback branch below
# (streaming was disabled because we couldn't open the log file)
# and use the original one-shot write -- preserves the previous
# behaviour for that edge case.
$logPath = Join-Path $InstallDir "install.log"
if ($global:LogFile) {
    Flush-Log
    try {
        Add-Content -LiteralPath $global:LogFile -Encoding UTF8 -Value @(
            "----------------------------------------",
            "Completed normally at $(Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz')."
        ) -ErrorAction Stop
    } catch {
        # Footer-write failure isn't worth crashing on; the
        # streamed body is intact.
    }
} else {
    # Fallback path: streaming was disabled; write everything in
    # one go, exactly like pre-Ship-67. If we hit this, the install
    # log might be incomplete (lines from before $InstallDir existed
    # are buffered, lines from after were never persisted).
    $header = @(
        "NoteControl install log",
        "Run at:  $(Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz')",
        "Version: $Version",
        "Mode:    $(if ($isUpgrade) { 'upgrade' } else { 'fresh install' })",
        "Source:  $DistRoot",
        "Target:  $InstallDir",
        "Data:    $DataRoot",
        "User:    $env:USERDOMAIN\$env:USERNAME",
        "----------------------------------------"
    )
    Set-Content -Path $logPath -Value ($header + $global:LogLines) -Encoding UTF8
}

# ---------------------------------------------------------------
# Done
# ---------------------------------------------------------------
Write-Host ""
Write-Host "================================================" -ForegroundColor Green
Write-Host " Done." -ForegroundColor Green
Write-Host "================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Service: $ServiceName ($([string](Get-Service -Name $ServiceName -ErrorAction SilentlyContinue).Status))"
Write-Host "  URL:     http://127.0.0.1:$Port  (default; check Server Settings to change)"
Write-Host "  Tray:    look for the icon next to the clock"
Write-Host "  Uninst:  Add/Remove Programs -> NoteControl, or run uninstall.ps1"
Write-Host "  Log:     $logPath"
Write-Host ""

if (-not $Silent) {
    Write-Host "Press Enter to exit..." -ForegroundColor DarkGray
    [void][System.Console]::ReadLine()
}
