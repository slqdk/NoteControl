<#
.SYNOPSIS
  Uninstall NoteControl from this Windows machine.

.DESCRIPTION
  Reverses what install.ps1 did:
    - Stops + deletes the service
    - Stops the tray if running
    - Removes the HKLM Run autostart entry
    - Removes the Add/Remove Programs entry
    - Deletes the install dir (binaries)

  Vault data under C:\ProgramData\NoteControl\ is left in place
  by default. Pass -RemoveData to also delete it -- you'll be
  asked to confirm interactively unless -Force is also given.

.PARAMETER InstallDir
  Where the binaries live. Defaults to "C:\Program Files\NoteControl"
  unless the script is running from inside the install dir, in which
  case we use that. (This handles the Add/Remove Programs path: the
  script is invoked as $InstallDir\uninstall.ps1 with no arguments.)

.PARAMETER ServiceName
  Default "NoteControlServer".

.PARAMETER RemoveData
  Switch -- also delete C:\ProgramData\NoteControl\ (notes data,
  database, logs, backups, server config). DESTRUCTIVE.

.PARAMETER Force
  Switch -- skip the interactive confirmation prompt for -RemoveData.
  Required for unattended uninstalls that delete data.

.PARAMETER Silent
  Switch -- suppress the "Press Enter to exit" pause at the end.

.EXAMPLE
  .\uninstall.ps1
  Uninstall but keep all notes data.

.EXAMPLE
  .\uninstall.ps1 -RemoveData
  Uninstall AND delete data, with an interactive confirmation prompt.

.EXAMPLE
  .\uninstall.ps1 -RemoveData -Force -Silent
  Unattended full uninstall. Use with care.
#>

[CmdletBinding()]
param(
    [string] $InstallDir,
    [string] $ServiceName = "NoteControlServer",
    [switch] $RemoveData,
    [switch] $Force,
    [switch] $Silent
)

$ErrorActionPreference = 'Continue'  # we tolerate "thing wasn't there" failures

# Default $InstallDir to wherever this script lives if not specified.
# Works for: Add/Remove Programs invocation (script is in the install
# dir), manual run from the install dir, and direct invocation with
# explicit -InstallDir.
if (-not $InstallDir) {
    $InstallDir = $PSScriptRoot
}

Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
Write-Host " NoteControl uninstaller" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan

# Admin check.
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal   = New-Object Security.Principal.WindowsPrincipal($currentUser)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host ""
    Write-Host "ERROR: This script must run as Administrator." -ForegroundColor Red
    Write-Host "  Right-click PowerShell -> 'Run as administrator', then re-run." -ForegroundColor Yellow
    Write-Host ""
    exit 1
}

# Resolve the data root the same way install.ps1 does. We don't try
# to read it from the installed appsettings.json because the user may
# have changed it via the Server Settings window since install -- the
# layered config in {DataRoot}/.server/config.json could override.
# For uninstall purposes we treat the default location as canonical.
$DataParent = "$env:ProgramData\NoteControl"

Write-Host ""
Write-Host "  Install dir: $InstallDir"
Write-Host "  Service:     $ServiceName"
Write-Host "  Data root:   $DataParent  $(if (-not $RemoveData) { '(will be KEPT)' } else { '(will be REMOVED)' })"
Write-Host ""

# ---------------------------------------------------------------
# Confirm data deletion if requested
# ---------------------------------------------------------------
if ($RemoveData -and -not $Force) {
    if (-not (Test-Path -LiteralPath $DataParent)) {
        Write-Host "  Data root doesn't exist; nothing to remove there." -ForegroundColor Yellow
        Write-Host ""
        $RemoveData = $false   # nothing to do
    } else {
        Write-Host "WARNING: -RemoveData will permanently delete all notes, backups, and config:" -ForegroundColor Red
        Write-Host "  $DataParent" -ForegroundColor Red
        Write-Host ""
        $reply = Read-Host "Type 'DELETE' (uppercase) to confirm, anything else to abort"
        if ($reply -ne 'DELETE') {
            Write-Host ""
            Write-Host "Aborted by user." -ForegroundColor Yellow
            Write-Host ""
            exit 1
        }
    }
}

# ---------------------------------------------------------------
# Stop + delete service
# ---------------------------------------------------------------
Write-Host "==> Stopping and removing service" -ForegroundColor Cyan

$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($service) {
    if ($service.Status -ne 'Stopped') {
        Write-Host "  Stopping $ServiceName ..."
        try {
            Stop-Service -Name $ServiceName -Force -ErrorAction Stop
            $deadline = (Get-Date).AddSeconds(30)
            while ((Get-Date) -lt $deadline) {
                $s = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
                if (-not $s -or $s.Status -eq 'Stopped') { break }
                Start-Sleep -Milliseconds 250
            }
        } catch {
            Write-Host "  Stop-Service failed: $($_.Exception.Message)" -ForegroundColor Yellow
            Write-Host "  Proceeding with delete anyway." -ForegroundColor Yellow
        }
    }
    Write-Host "  Deleting service ..."
    & sc.exe delete $ServiceName | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  sc.exe delete returned $LASTEXITCODE; service may need a reboot to fully unregister." -ForegroundColor Yellow
    } else {
        Write-Host "  Service removed." -ForegroundColor Green
    }
} else {
    Write-Host "  Service not registered. Nothing to do." -ForegroundColor DarkGray
}

# ---------------------------------------------------------------
# Stop tray
# ---------------------------------------------------------------
Write-Host "==> Stopping tray" -ForegroundColor Cyan

$trayProcs = Get-Process -Name "NoteControl.Tray" -ErrorAction SilentlyContinue
if ($trayProcs) {
    Write-Host "  Stopping $($trayProcs.Count) tray process(es) ..."
    $trayProcs | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
    Write-Host "  Tray stopped." -ForegroundColor Green
} else {
    Write-Host "  Tray not running." -ForegroundColor DarkGray
}

# ---------------------------------------------------------------
# Remove autostart + ARP entries
# ---------------------------------------------------------------
Write-Host "==> Removing registry entries" -ForegroundColor Cyan

$runKey   = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run'
$runValue = 'NoteControlTray'
if (Test-Path -LiteralPath $runKey) {
    if (Get-ItemProperty -Path $runKey -Name $runValue -ErrorAction SilentlyContinue) {
        Remove-ItemProperty -Path $runKey -Name $runValue -ErrorAction SilentlyContinue
        Write-Host "  Removed HKLM\...\Run\$runValue" -ForegroundColor Green
    }
}

$uninstallKey = "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\NoteControl"
if (Test-Path -LiteralPath $uninstallKey) {
    Remove-Item -LiteralPath $uninstallKey -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "  Removed Add/Remove Programs entry" -ForegroundColor Green
}

# ---------------------------------------------------------------
# Delete install dir
# ---------------------------------------------------------------
Write-Host "==> Removing install dir" -ForegroundColor Cyan

# Subtle: we may be CURRENTLY EXECUTING from $InstallDir\uninstall.ps1.
# PowerShell holds an open handle on the script file while running.
# Removing the directory tree from inside itself works on Windows
# IFF nothing inside is locked, but the script file itself is. Two
# safe approaches:
#   1. Self-delete via a scheduled cmd shell that runs after we exit
#   2. Best-effort delete now, leave the script for the user to remove
# Going with #2 -- simpler and the leftover script + log are useful
# forensics. We DO try to delete most of the contents though.
if (Test-Path -LiteralPath $InstallDir) {
    # Delete everything except this script and its containing dir
    # if we're running from inside the install dir.
    $scriptFullPath = $MyInvocation.MyCommand.Path
    $runningFromInstallDir = $scriptFullPath -and $scriptFullPath.StartsWith($InstallDir, [StringComparison]::OrdinalIgnoreCase)

    if ($runningFromInstallDir) {
        # Remove children one-by-one, skipping our own script.
        Get-ChildItem -LiteralPath $InstallDir -Force | ForEach-Object {
            $itemFullPath = $_.FullName
            # Skip the script we're running from (and the log we wrote).
            if ($itemFullPath -ieq $scriptFullPath) { return }
            try {
                Remove-Item -LiteralPath $itemFullPath -Recurse -Force -ErrorAction Stop
            } catch {
                Write-Host "  Could not remove $itemFullPath: $($_.Exception.Message)" -ForegroundColor Yellow
            }
        }
        Write-Host "  Cleared install dir contents." -ForegroundColor Green
        Write-Host "  NOTE: $scriptFullPath remains; PowerShell holds it open while running." -ForegroundColor DarkGray
        Write-Host "        You can delete it manually after this script exits, or run:" -ForegroundColor DarkGray
        Write-Host "        Remove-Item '$InstallDir' -Recurse -Force" -ForegroundColor DarkGray
    } else {
        Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host "  Removed $InstallDir" -ForegroundColor Green
    }
}

# ---------------------------------------------------------------
# Optional: remove data
# ---------------------------------------------------------------
if ($RemoveData) {
    Write-Host "==> Removing data" -ForegroundColor Cyan
    if (Test-Path -LiteralPath $DataParent) {
        Remove-Item -LiteralPath $DataParent -Recurse -Force -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $DataParent) {
            Write-Host "  Some files could not be removed from $DataParent." -ForegroundColor Yellow
            Write-Host "  Likely held open by a tray that hasn't fully exited; try again." -ForegroundColor Yellow
        } else {
            Write-Host "  Removed $DataParent" -ForegroundColor Green
        }
    }
}

# ---------------------------------------------------------------
# Done
# ---------------------------------------------------------------
Write-Host ""
Write-Host "================================================" -ForegroundColor Green
Write-Host " Uninstall complete." -ForegroundColor Green
Write-Host "================================================" -ForegroundColor Green
Write-Host ""

if (-not $RemoveData -and (Test-Path -LiteralPath $DataParent)) {
    Write-Host "  Vault data preserved at: $DataParent"
    Write-Host "  Re-installing will pick this back up automatically."
    Write-Host ""
}

if (-not $Silent) {
    Write-Host "Press Enter to exit..." -ForegroundColor DarkGray
    [void][System.Console]::ReadLine()
}
