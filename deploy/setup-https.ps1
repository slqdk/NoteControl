<#
.SYNOPSIS
  Set up HTTPS for NoteControl by installing Caddy as a Windows
  Service. Idempotent — safe to re-run.

.DESCRIPTION
  Ship 93 — Caddy fronts NoteControl on ports 80 + 443 and reverse-
  proxies HTTPS traffic to Kestrel on a local-only port. Hostname
  list lives in NoteControl's Tray Settings (HTTPS tab); the server
  generates the Caddyfile from that list and tells Caddy to reload
  whenever it changes.

  This script:
    1. Verifies Caddy is installed (caddy.exe on PATH or in
       C:\Program Files\Caddy). If missing, prints a download URL
       and exits — auto-download is skipped on purpose so YOU make
       the security decision actively.
    2. Ensures the data directory exists at
       C:\ProgramData\NoteControl\caddy\ (the Caddyfile lives here)
       and that NoteControl Server has written an initial Caddyfile.
    3. Installs Caddy as a Windows Service that auto-starts on
       boot and reads the Caddyfile from the path above. Uses
       Caddy's built-in service support if available, falls back
       to a manual service registration via sc.exe.
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
  Caddy itself or delete the Caddyfile — just unwinds what the
  Install path adds. Use this if you want to stop fronting with
  HTTPS and go back to direct Kestrel access.

.PARAMETER CaddyExe
  Override the path to caddy.exe. Default: search PATH, then
  C:\Program Files\Caddy\caddy.exe.

.PARAMETER CaddyfilePath
  Override the Caddyfile path. Default:
  C:\ProgramData\NoteControl\caddy\Caddyfile

.EXAMPLE
  # Dry run — see what would happen
  .\setup-https.ps1 -WhatIf

.EXAMPLE
  # Install
  .\setup-https.ps1

.EXAMPLE
  # Remove the service + firewall rules
  .\setup-https.ps1 -Uninstall

.NOTES
  Run as Administrator. Service registration and firewall rule
  management both require it.

  Caddy download:
    https://caddyserver.com/download
  Pick "Windows / amd64 / caddy" — single .exe, no installer needed.
  Drop it in C:\Program Files\Caddy\ and re-run this script.
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch]$Uninstall,
    [string]$CaddyExe,
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

function Resolve-CaddyExe {
    if ($script:CaddyExe -and (Test-Path $script:CaddyExe)) {
        return (Resolve-Path $script:CaddyExe).Path
    }
    # PATH lookup
    $cmd = Get-Command caddy.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    # Conventional install location
    $conventional = 'C:\Program Files\Caddy\caddy.exe'
    if (Test-Path $conventional) { return $conventional }
    return $null
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

# 1. Locate caddy.exe
Write-Step "Locating caddy.exe"
$caddy = Resolve-CaddyExe
if (-not $caddy) {
    Write-Host ""
    Write-Host "ERROR: caddy.exe not found." -ForegroundColor Red
    Write-Host ""
    Write-Host "  Download Caddy for Windows from:" -ForegroundColor White
    Write-Host "    https://caddyserver.com/download" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Pick 'Windows' + 'amd64' + click 'Download'." -ForegroundColor White
    Write-Host "  Save caddy.exe to: C:\Program Files\Caddy\caddy.exe" -ForegroundColor White
    Write-Host "  (Create the folder if needed.)" -ForegroundColor White
    Write-Host ""
    Write-Host "  Then re-run this script." -ForegroundColor White
    Write-Host ""
    exit 1
}
Write-OK "Found caddy.exe at: $caddy"

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
    Write-Warn "Continuing — Caddy will be unhappy until the file appears, but the"
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
        # Use sc.exe rather than New-Service so we can set the
        # binPath with arguments. New-Service in PowerShell 5.1
        # doesn't support spaces in arg-baked binPath without
        # gymnastics; sc.exe handles it cleanly with quotes.
        # The space after each = in sc.exe args is REQUIRED.
        $binPath = '"' + $caddy + '" run --config "' + $CaddyfilePath + '" --adapter caddyfile'
        $result = sc.exe create caddy `
            binPath= $binPath `
            start= auto `
            DisplayName= "Caddy (NoteControl HTTPS)"
        if ($LASTEXITCODE -ne 0) {
            Write-Host "ERROR: sc.exe create caddy failed: $result" -ForegroundColor Red
            exit 1
        }
        # Description (optional but useful in services.msc).
        sc.exe description caddy "Reverse proxy + HTTPS for NoteControl. Reads Caddyfile from $CaddyfilePath." | Out-Null
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
