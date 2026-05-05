<#
.SYNOPSIS
  Set up HTTPS for NoteControl by installing Caddy as a Windows
  Service. Idempotent - safe to re-run.

.DESCRIPTION
  Ship 93 - Caddy fronts NoteControl on ports 80 + 443 and reverse-
  proxies HTTPS traffic to Kestrel on a local-only port. Hostname
  list lives in NoteControl's Tray Settings (HTTPS tab); the server
  generates the Caddyfile from that list and tells Caddy to reload
  whenever it changes.

  This script:
    1. Deploys caddy.exe from the script's own folder to
       C:\Program Files\Caddy\caddy.exe. The bundled exe is the
       source of truth - re-running this script is also "upgrade
       Caddy". Always-overwrite, so the version next to the script
       IS the version that runs. If a caddy service is already
       running when this step executes, it's stopped briefly so
       the file isn't locked, then restarted.
    2. Ensures the data directory exists at
       C:\ProgramData\NoteControl\caddy\ (the Caddyfile lives here)
       and that NoteControl Server has written an initial Caddyfile.
    3. Installs Caddy as a Windows Service that auto-starts on
       boot and reads the Caddyfile from the path above.
    4. Opens Windows Firewall for inbound TCP 80 + 443.
    5. Starts the Caddy service.

  Re-run anytime: existing service / firewall rules are detected
  and skipped. To remove what this script installed, run with
  -Uninstall.

.PARAMETER WhatIf
  Dry run: print what would happen, don't actually change anything.
  Use this first to see the plan.

.PARAMETER Uninstall
  Remove the Caddy service + firewall rules. Doesn't uninstall
  caddy.exe or delete the Caddyfile - just unwinds what the
  Install path adds. Use this if you want to stop fronting with
  HTTPS and go back to direct Kestrel access.

.PARAMETER CaddyfilePath
  Override the Caddyfile path. Default:
  C:\ProgramData\NoteControl\caddy\Caddyfile

.EXAMPLE
  # Dry run - see what would happen
  .\setup-https.ps1 -WhatIf

.EXAMPLE
  # Install (or upgrade caddy.exe + apply config)
  .\setup-https.ps1

.EXAMPLE
  # Remove the service + firewall rules
  .\setup-https.ps1 -Uninstall

.NOTES
  Run as Administrator. Service registration and firewall rule
  management both require it.

  caddy.exe must be present next to this script. Download from:
    https://caddyserver.com/download
  Pick "Windows / amd64 / caddy" - single .exe, no installer needed.
  Save the downloaded file as caddy.exe in this deploy folder.
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch]$Uninstall,
    [string]$CaddyfilePath = 'C:\ProgramData\NoteControl\caddy\Caddyfile'
)

$ErrorActionPreference = 'Stop'

# ----------------------------------------------------------------- helpers

function Write-Step([string]$message) {
    Write-Host "==>" -ForegroundColor Cyan -NoNewline
    Write-Host " $message"
}

function Write-OK([string]$message) {
    Write-Host "  OK" -ForegroundColor Green -NoNewline
    Write-Host " $message"
}

function Write-Skip([string]$message) {
    Write-Host "  --" -ForegroundColor DarkGray -NoNewline
    Write-Host " $message"
}

function Write-Warn([string]$message) {
    Write-Host "  !!" -ForegroundColor Yellow -NoNewline
    Write-Host " $message"
}

function Test-Admin {
    $id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object System.Security.Principal.WindowsPrincipal($id)
    return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

# ----------------------------------------------------------------- preflight

Write-Host ""
Write-Host "NoteControl HTTPS Setup (Ship 93)" -ForegroundColor White
Write-Host "===================================" -ForegroundColor White
Write-Host ""

if (-not (Test-Admin)) {
    Write-Host "ERROR: This script requires Administrator privileges." -ForegroundColor Red
    Write-Host "       Right-click PowerShell and 'Run as Administrator', then re-run." -ForegroundColor Red
    exit 1
}

# ----------------------------------------------------------------- uninstall path

if ($Uninstall) {
    Write-Step "Uninstalling Caddy service + firewall rules"

    # 1. Stop + remove the service
    $svc = Get-Service -Name 'caddy' -ErrorAction SilentlyContinue
    if ($svc) {
        if ($svc.Status -eq 'Running') {
            if ($PSCmdlet.ShouldProcess('caddy service', 'Stop')) {
                Stop-Service -Name 'caddy' -Force
                Write-OK "Stopped caddy service"
            }
        }
        if ($PSCmdlet.ShouldProcess('caddy service', 'Delete')) {
            sc.exe delete caddy | Out-Null
            Write-OK "Removed caddy service"
        }
    } else {
        Write-Skip "caddy service not present"
    }

    # 2. Remove firewall rules
    foreach ($name in @('NoteControl Caddy HTTP (80)', 'NoteControl Caddy HTTPS (443)')) {
        $rule = Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue
        if ($rule) {
            if ($PSCmdlet.ShouldProcess($name, 'Remove firewall rule')) {
                Remove-NetFirewallRule -DisplayName $name
                Write-OK "Removed firewall rule: $name"
            }
        } else {
            Write-Skip "Firewall rule '$name' not present"
        }
    }

    Write-Host ""
    Write-Host "Uninstall complete." -ForegroundColor Green
    Write-Host "Note: caddy.exe + the Caddyfile were NOT removed." -ForegroundColor DarkGray
    exit 0
}

# ----------------------------------------------------------------- install path

# 1. Deploy caddy.exe from the script folder to the install location.
#
# Ship 93 (revised): caddy.exe ships next to setup-https.ps1 in the
# deploy folder. The script copies it to a stable install location
# every time it runs, so re-running the script is also "upgrade
# Caddy". Always-overwrite means: the version next to the script IS
# the version that gets installed.
#
# The destination is C:\Program Files\Caddy\caddy.exe to match the
# convention the rest of this script (and Caddy's own docs) expects.
# We don't store it under DataRoot because that directory is meant
# to be service-writable; an executable there is a soft attack
# surface (compromised service could swap it).
Write-Step "Deploying caddy.exe"

$sourceCaddy = Join-Path $PSScriptRoot 'caddy.exe'
$destCaddyDir = 'C:\Program Files\Caddy'
$destCaddy = Join-Path $destCaddyDir 'caddy.exe'

if (-not (Test-Path $sourceCaddy)) {
    Write-Host ""
    Write-Host "ERROR: caddy.exe not found next to this script." -ForegroundColor Red
    Write-Host ""
    Write-Host "  Expected at: $sourceCaddy" -ForegroundColor White
    Write-Host ""
    Write-Host "  Download Caddy for Windows from:" -ForegroundColor White
    Write-Host "    https://caddyserver.com/download" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Pick 'Windows' + 'amd64' + click 'Download'." -ForegroundColor White
    Write-Host "  Save the downloaded file as caddy.exe in the deploy folder" -ForegroundColor White
    Write-Host "  (next to this script), then re-run." -ForegroundColor White
    Write-Host ""
    exit 1
}
Write-OK "Found bundled caddy.exe at: $sourceCaddy"

# Ensure destination directory exists.
if (-not (Test-Path $destCaddyDir)) {
    if ($PSCmdlet.ShouldProcess($destCaddyDir, 'Create directory')) {
        New-Item -ItemType Directory -Path $destCaddyDir -Force | Out-Null
        Write-OK "Created $destCaddyDir"
    }
} else {
    Write-Skip "$destCaddyDir already exists"
}

# If Caddy is currently running, the destination .exe is locked.
# Stop the service before copying, restart it after. Detect this
# by checking the service's status, not by trying to copy and
# catching the error - cleaner.
$wasRunning = $false
$existingSvc = Get-Service -Name 'caddy' -ErrorAction SilentlyContinue
if ($existingSvc -and $existingSvc.Status -eq 'Running') {
    if ($PSCmdlet.ShouldProcess('caddy service', 'Stop (to allow exe overwrite)')) {
        Stop-Service -Name 'caddy' -Force
        Write-OK "Stopped caddy service so caddy.exe can be replaced"
        $wasRunning = $true
        # Brief wait: Stop-Service returns when the service control
        # manager has accepted the stop, but the process may still
        # be releasing handles. A short sleep avoids a race where
        # Copy-Item fails with 'file in use'.
        Start-Sleep -Milliseconds 500
    }
}

# Copy with overwrite. Always-overwrite is the design: the bundled
# caddy.exe IS the source of truth.
if ($PSCmdlet.ShouldProcess($destCaddy, 'Copy caddy.exe (overwrite if exists)')) {
    Copy-Item -Path $sourceCaddy -Destination $destCaddy -Force
    Write-OK "Copied caddy.exe to $destCaddy"
}

# From here on, $caddy is the install path - that's what we
# register the service against and what `caddy reload` will use.
$caddy = $destCaddy

# Restart the service if we stopped it. We do this BEFORE the
# service-creation step below so the service-already-running check
# correctly reflects "this caddy.exe upgrade is complete and the
# service is back online" rather than "left it stopped, will start
# at the bottom of the script". Idempotent re-runs land here in
# the steady state.
if ($wasRunning) {
    if ($PSCmdlet.ShouldProcess('caddy service', 'Start (post-upgrade)')) {
        try {
            Start-Service -Name 'caddy'
            Write-OK "Restarted caddy service after upgrade"
        } catch {
            Write-Warn "Could not restart service after exe upgrade: $($_.Exception.Message)"
            Write-Warn "Will try again at the end of the script."
        }
    }
}

# 2. Verify Caddyfile path
Write-Step "Verifying Caddyfile path"
$caddyDir = Split-Path -Parent $CaddyfilePath
if (-not (Test-Path $caddyDir)) {
    if ($PSCmdlet.ShouldProcess($caddyDir, 'Create directory')) {
        New-Item -ItemType Directory -Path $caddyDir -Force | Out-Null
        Write-OK "Created $caddyDir"
    }
} else {
    Write-Skip "$caddyDir already exists"
}

if (-not (Test-Path $CaddyfilePath)) {
    Write-Warn "Caddyfile not found at $CaddyfilePath."
    Write-Warn "The NoteControl Server creates it on startup; if you've run the"
    Write-Warn "server at least once after applying Ship 93, the file should exist."
    Write-Warn "Continuing - Caddy will be unhappy until the file appears, but the"
    Write-Warn "service registration will succeed regardless."
} else {
    Write-OK "Caddyfile found at $CaddyfilePath"
}

# 3. Install Caddy as a Windows Service
Write-Step "Installing Caddy as a Windows Service"
$svc = Get-Service -Name 'caddy' -ErrorAction SilentlyContinue
if ($svc) {
    Write-Skip "Service 'caddy' already exists (status: $($svc.Status))"
} else {
    if ($PSCmdlet.ShouldProcess('caddy service', 'Create')) {
        # PowerShell 5.1's `sc.exe create caddy binPath= "..."` is
        # surprisingly fragile: PowerShell treats `binPath=` and the
        # quoted value as separate tokens, sc.exe sees an empty
        # binPath and prints its USAGE help. Workarounds (escaping,
        # array splatting, --% literal stop-parsing) all work but
        # are subtle. New-Service is the PowerShell-native
        # equivalent and avoids the entire mess.
        #
        # The BinaryPathName accepts a single string with the
        # full command line (exe + args). Embedded spaces in the
        # exe path go inside literal double quotes within the
        # string so the SCM later splits it correctly.
        $binPath = '"' + $caddy + '" run --config "' + $CaddyfilePath + '" --adapter caddyfile'
        try {
            New-Service `
                -Name 'caddy' `
                -BinaryPathName $binPath `
                -DisplayName 'Caddy (NoteControl HTTPS)' `
                -Description "Reverse proxy + HTTPS for NoteControl. Reads Caddyfile from $CaddyfilePath." `
                -StartupType Automatic | Out-Null
        } catch {
            Write-Host "ERROR: New-Service caddy failed: $($_.Exception.Message)" -ForegroundColor Red
            exit 1
        }
        Write-OK "Service 'caddy' created"
    }
}

# 4. Open firewall for 80 + 443
Write-Step "Opening Windows Firewall for inbound TCP 80 + 443"
foreach ($spec in @(
    @{ Name = 'NoteControl Caddy HTTP (80)';  Port = 80  },
    @{ Name = 'NoteControl Caddy HTTPS (443)'; Port = 443 }
)) {
    $existing = Get-NetFirewallRule -DisplayName $spec.Name -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Skip "Firewall rule '$($spec.Name)' already exists"
    } else {
        if ($PSCmdlet.ShouldProcess($spec.Name, 'Create firewall rule')) {
            New-NetFirewallRule `
                -DisplayName $spec.Name `
                -Direction Inbound `
                -Action Allow `
                -Protocol TCP `
                -LocalPort $spec.Port `
                -Profile Any | Out-Null
            Write-OK "Created firewall rule: $($spec.Name) on TCP $($spec.Port)"
        }
    }
}

# 5. Start the service
Write-Step "Starting Caddy service"
$svc = Get-Service -Name 'caddy' -ErrorAction SilentlyContinue
if ($svc) {
    if ($svc.Status -eq 'Running') {
        Write-Skip "Service already running"
    } else {
        if ($PSCmdlet.ShouldProcess('caddy service', 'Start')) {
            try {
                Start-Service -Name 'caddy'
                Write-OK "Service started"
            } catch {
                Write-Warn "Could not start service: $($_.Exception.Message)"
                Write-Warn "Check the Windows Event Log (Application) for Caddy errors."
                Write-Warn "Most common cause: port 80 or 443 already bound by another"
                Write-Warn "process (IIS, Skype, Apache). Stop the conflicting service"
                Write-Warn "and run 'Start-Service caddy' again."
            }
        }
    }
}

# ----------------------------------------------------------------- next steps

Write-Host ""
Write-Host "Setup complete." -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor White
Write-Host "  1. Open NoteControl tray > Server Settings > HTTPS tab."
Write-Host "  2. Add one or more public hostnames (one per line)."
Write-Host "  3. Click Save. The server regenerates the Caddyfile and"
Write-Host "     asks Caddy to reload."
Write-Host "  4. Verify: navigate to https://<hostname> in a browser."
Write-Host "     First-time cert provisioning takes 1-2 minutes."
Write-Host ""
Write-Host "Logs:" -ForegroundColor White
Write-Host "  Server : C:\ProgramData\NoteControl\logs\notecontrol-*.log"
Write-Host "  Caddy  : C:\ProgramData\NoteControl\logs\caddy-access.log"
Write-Host "  Service: services.msc > Caddy > Properties > Recover/Logs"
Write-Host ""
