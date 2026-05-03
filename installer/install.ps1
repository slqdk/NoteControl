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
$global:LogLines = New-Object System.Collections.Generic.List[string]
function Write-Step {
    param([string]$Message, [ConsoleColor]$Color = [ConsoleColor]::White)
    Write-Host "  $Message" -ForegroundColor $Color
    $global:LogLines.Add("[$(Get-Date -Format 'HH:mm:ss')] $Message")
}
function Write-Section {
    param([string]$Title)
    Write-Host ""
    Write-Host "==> $Title" -ForegroundColor Cyan
    $global:LogLines.Add("")
    $global:LogLines.Add("==> $Title")
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
$trayProcs = Get-Process -Name "NoteControl.Tray" -ErrorAction SilentlyContinue
if ($trayProcs) {
    Write-Step "Stopping tray ($($trayProcs.Count) process(es))..."
    $trayProcs | Stop-Process -Force -ErrorAction SilentlyContinue
    # Brief settle so the file handle releases.
    Start-Sleep -Milliseconds 500
    Write-Step "  Tray stopped." Green
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

Write-Step "Copying server\ ..."
Copy-Item -Path $ServerSrc -Destination $InstallDir -Recurse -Force
Write-Step "Copying tray\ ..."
Copy-Item -Path $TraySrc   -Destination $InstallDir -Recurse -Force

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
# Start service + health check
# ---------------------------------------------------------------
Write-Section "Starting service"

Start-Service -Name $ServiceName -ErrorAction Stop

# Wait for /health. The server publishes its bound URL to
# {DataRoot}\.server\server.url (Ship 43); we could read that for
# a perfectly accurate probe target, but at install time we just
# care about the configured default port. A misconfigured port
# isn't an installer failure -- the service is still installed
# and the user can fix config and restart.
$healthUrl = "http://127.0.0.1:$Port/health"
Write-Step "Probing $healthUrl ..."
$healthy = $false
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
    try {
        $r = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
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
    Write-Step "  Service is responding to /health." Green
} else {
    Write-Step "  Service didn't respond on $healthUrl within 30s." Yellow
    Write-Step "  Check logs at $logsDir for clues. Service is still registered." Yellow
}

# ---------------------------------------------------------------
# Tray autostart (HKLM Run)
# ---------------------------------------------------------------
Write-Section "Registering tray autostart"

$runKey   = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run'
$runValue = 'NoteControlTray'
$trayExe  = Join-Path $InstallDir "tray\NoteControl.Tray.exe"
# Quote the path because Program Files contains a space.
$trayCmd  = '"' + $trayExe + '"'

if (-not (Test-Path -LiteralPath $runKey)) {
    # Should always exist on a sane Windows install; create defensively.
    New-Item -Path $runKey -Force | Out-Null
}
Set-ItemProperty -Path $runKey -Name $runValue -Value $trayCmd -Type String
Write-Step "  HKLM\...\Run\$runValue = $trayCmd" Green

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

    # Subtle bit: this script runs elevated. If we just Start-Process
    # the tray here, the tray inherits the elevated token, which is
    # fine but also means it runs as Administrator and HKCU points
    # at the elevated user's profile. For the "your tray is up,
    # talking to a server you can manage" flow, that's actually what
    # we want during an install -- the admin who installed it should
    # see the tray.
    #
    # On next login (and for non-admin users), the HKLM Run entry
    # launches the tray non-elevated for whichever user logged in.
    Start-Process -FilePath $trayExe -ErrorAction SilentlyContinue
    Write-Step "  Tray launched." Green
} else {
    Write-Step "Skipping tray launch (-NoTrayLaunch). HKLM Run entry will launch on next login." Yellow
}

# ---------------------------------------------------------------
# Persist the install log inside the install dir
# ---------------------------------------------------------------
$logPath = Join-Path $InstallDir "install.log"
$header  = @(
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
