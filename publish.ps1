<#
.SYNOPSIS
  Build a self-contained, versioned NoteControl distribution.

.DESCRIPTION
  Produces dist\NoteControl-<Version>\ containing the published
  server (with the React frontend inlined into wwwroot\), the tray
  app, the installer scripts, and a VERSION.txt. Everything in the
  dist folder is what gets shipped -- a user runs installer\install.ps1
  to install onto a target machine.

  Layout:
    dist\NoteControl-<Version>\
      server\                       Self-contained server + frontend
        NoteControl.Server.exe
        appsettings.json
        wwwroot\                    Vite build output, served by Kestrel
          index.html
          assets\
        ...native libs, *.dll
      tray\                         Self-contained tray
        NoteControl.Tray.exe
        ...
      installer\                    PowerShell installer (Ship 48)
        install.ps1
        uninstall.ps1
      VERSION.txt                   Just the version string + git SHA

  Optionally produces dist\NoteControl-<Version>.zip alongside
  the folder if -Zip is passed. The zip is what goes on GitHub
  Releases.

.PARAMETER Version
  Version string, e.g. "1.0.0". Required. Stamped into the dist
  folder name and VERSION.txt. Not currently injected into
  assemblies (that's a later polish -- assembly versions stay at
  whatever the .csproj has).

.PARAMETER Configuration
  Debug | Release. Defaults to Release. You'd only set this to
  Debug to hand-test something specific; release builds are what
  ship.

.PARAMETER Runtime
  Runtime identifier for self-contained publish. Defaults to
  win-x64. NoteControl is Windows-only.

.PARAMETER Zip
  Switch -- if set, also produce a .zip of the dist folder for
  easy hand-distribution / GitHub Releases upload.

.PARAMETER SkipFrontend
  Switch -- skip the npm build step. Useful if you've already
  built the frontend and just want to re-publish backend code
  faster.

.PARAMETER SkipTray
  Switch -- skip the tray publish. Useful for server-only iteration.

.EXAMPLE
  .\publish.ps1 -Version 1.0.0
  Build dist\NoteControl-1.0.0\ in Release mode.

.EXAMPLE
  .\publish.ps1 -Version 1.0.0 -Zip
  Build the dist folder AND a zip alongside it. Upload that zip
  to a GitHub Release.

.NOTES
  Run from the repository root. Requires:
    - .NET 8 SDK on PATH (`dotnet --version` should print 8.x)
    - Node + npm on PATH (`node -v`, `npm -v`)
    - The repo's working tree to be clean enough to publish from
      (no lock files held by a running server / tray)

  Stop the dev server BEFORE running this script. A live tray
  holding NoteControl.Tray.exe will make `dotnet publish` fail
  with a file-locked error. `start-dev.cmd` should be closed.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)]
    [string]$Version,

    [ValidateSet("Debug","Release")]
    [string]$Configuration = "Release",

    [string]$Runtime = "win-x64",

    [switch]$Zip,
    [switch]$SkipFrontend,
    [switch]$SkipTray
)

# Stop on first error. Without this, a failure in the middle of
# publish leaves a half-assembled dist folder that looks valid
# but isn't.
$ErrorActionPreference = "Stop"

# Resolve everything relative to the script's location so the
# script works whether you cd into the repo first or invoke it
# by full path.
$RepoRoot   = $PSScriptRoot
$SrcRoot    = Join-Path $RepoRoot "src"
$ServerProj = Join-Path $SrcRoot "NoteControl.Server\NoteControl.Server.csproj"
$TrayProj   = Join-Path $SrcRoot "NoteControl.Tray\NoteControl.Tray.csproj"
$FrontDir   = Join-Path $SrcRoot "NoteControl.Frontend"
$InstallerDir = Join-Path $RepoRoot "installer"
$DistRoot   = Join-Path $RepoRoot "dist"
$DistDir    = Join-Path $DistRoot "NoteControl-$Version"

Write-Host ""
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host " NoteControl publish: v$Version ($Configuration / $Runtime)" -ForegroundColor Cyan
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host ""

# ---------------------------------------------------------------
# Tooling sanity checks.
# ---------------------------------------------------------------
function Test-Tool {
    param([string]$Name, [string]$VersionArg = "--version")
    try {
        $output = & $Name $VersionArg 2>&1
        Write-Host "  [ok] $Name`: $($output | Select-Object -First 1)" -ForegroundColor DarkGray
    } catch {
        throw "$Name not found on PATH. Install it before running this script."
    }
}

Write-Host "Checking tools..." -ForegroundColor White
Test-Tool "dotnet"
if (-not $SkipFrontend) {
    Test-Tool "node" "-v"
    Test-Tool "npm"  "-v"
}
Write-Host ""

# Check the installer folder exists; bail early so we don't go through
# a 90-second build only to fail at copy time.
if (-not (Test-Path -LiteralPath $InstallerDir)) {
    throw "Installer folder not found at $InstallerDir. Did Ship 48 land cleanly?"
}

# ---------------------------------------------------------------
# Clean previous output for THIS version. Leaves other versions'
# folders alone -- useful when you're iterating between v1.0.0-rc1
# and v1.0.0-rc2 etc.
# ---------------------------------------------------------------
if (Test-Path $DistDir) {
    Write-Host "Cleaning previous $DistDir ..." -ForegroundColor White
    Remove-Item $DistDir -Recurse -Force
}
New-Item -ItemType Directory -Path $DistDir | Out-Null

# ---------------------------------------------------------------
# Frontend build.
# Output lands in src\NoteControl.Frontend\dist\.
# ---------------------------------------------------------------
$FrontDistDir = Join-Path $FrontDir "dist"
if (-not $SkipFrontend) {
    Write-Host "Building frontend..." -ForegroundColor White
    Push-Location $FrontDir
    try {
        # `npm ci` would be more reproducible than `npm install` for
        # release builds. We don't run it unconditionally because
        # the dev workflow already keeps node_modules in sync; for
        # a release machine where node_modules might be missing,
        # uncomment the line below or run it once manually.
        # & npm ci
        # The contract said "no npm install unless absolutely
        # needed" -- this script DOES need a build, but assumes
        # the node_modules are already there from your dev work.
        & npm run build
        if ($LASTEXITCODE -ne 0) {
            throw "Frontend build failed (npm run build returned $LASTEXITCODE)"
        }
    } finally {
        Pop-Location
    }
} else {
    Write-Host "Skipping frontend build (-SkipFrontend)" -ForegroundColor Yellow
}

if (-not (Test-Path (Join-Path $FrontDistDir "index.html"))) {
    throw "Frontend dist not found at $FrontDistDir. Did the build succeed?"
}
Write-Host ""

# ---------------------------------------------------------------
# Server publish.
# Folder publish (per the project decision): faster cold start
# and easier patching than single-file. Self-contained so the
# target machine doesn't need a separate .NET runtime install.
# ---------------------------------------------------------------
$ServerOut = Join-Path $DistDir "server"
Write-Host "Publishing server..." -ForegroundColor White

& dotnet publish $ServerProj `
    --configuration $Configuration `
    --runtime $Runtime `
    --self-contained true `
    -p:PublishSingleFile=false `
    -p:PublishReadyToRun=true `
    --output $ServerOut

if ($LASTEXITCODE -ne 0) {
    throw "Server publish failed (dotnet publish returned $LASTEXITCODE)"
}

# ---------------------------------------------------------------
# Inline frontend into the server's wwwroot.
# Program.cs serves static files from {ContentRoot}/wwwroot in
# production. Copy the Vite build straight in.
# ---------------------------------------------------------------
$ServerWwwroot = Join-Path $ServerOut "wwwroot"
if (Test-Path $ServerWwwroot) {
    Remove-Item $ServerWwwroot -Recurse -Force
}
Write-Host "Copying frontend into server\wwwroot..." -ForegroundColor White
# -Recurse copies the whole tree; -Force overwrites existing files
# (shouldn't be any after the cleanup above, but defensive).
Copy-Item $FrontDistDir $ServerWwwroot -Recurse -Force
Write-Host ""

# ---------------------------------------------------------------
# Tray publish.
# ---------------------------------------------------------------
if (-not $SkipTray) {
    $TrayOut = Join-Path $DistDir "tray"
    Write-Host "Publishing tray..." -ForegroundColor White

    & dotnet publish $TrayProj `
        --configuration $Configuration `
        --runtime $Runtime `
        --self-contained true `
        -p:PublishSingleFile=false `
        -p:PublishReadyToRun=true `
        --output $TrayOut

    if ($LASTEXITCODE -ne 0) {
        throw "Tray publish failed (dotnet publish returned $LASTEXITCODE)"
    }
    Write-Host ""
} else {
    Write-Host "Skipping tray publish (-SkipTray)" -ForegroundColor Yellow
    Write-Host ""
}

# ---------------------------------------------------------------
# Copy installer into the dist folder.
# Ship 48: this is what makes the resulting zip self-installable.
# Without it, the user would download the zip and have to figure
# out how to start the server manually.
# ---------------------------------------------------------------
Write-Host "Copying installer..." -ForegroundColor White
Copy-Item $InstallerDir -Destination $DistDir -Recurse -Force
Write-Host ""

# ---------------------------------------------------------------
# VERSION.txt -- useful both for the installer and for "which
# build is this?" forensics on someone else's machine.
# ---------------------------------------------------------------
$gitSha = ""
try {
    $gitSha = (& git -C $RepoRoot rev-parse --short HEAD 2>$null).Trim()
} catch { }

$versionContent = @"
NoteControl
Version:       $Version
Configuration: $Configuration
Runtime:       $Runtime
Built:         $((Get-Date).ToString("yyyy-MM-ddTHH:mm:sszzz"))
Git SHA:       $gitSha
"@
Set-Content -Path (Join-Path $DistDir "VERSION.txt") -Value $versionContent -Encoding UTF8

# ---------------------------------------------------------------
# Optional zip.
# Naming matches what we'll upload to GitHub Releases as the
# release asset. The tray's update flow (Ship 49) downloads this
# exact filename.
# ---------------------------------------------------------------
if ($Zip) {
    $ZipPath = Join-Path $DistRoot "NoteControl-$Version.zip"
    if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }
    Write-Host "Creating $ZipPath ..." -ForegroundColor White
    Compress-Archive -Path $DistDir -DestinationPath $ZipPath -Force
}

# ---------------------------------------------------------------
# Summary.
# ---------------------------------------------------------------
$serverSize = (Get-ChildItem $ServerOut -Recurse | Measure-Object -Property Length -Sum).Sum
Write-Host ""
Write-Host "======================================================" -ForegroundColor Green
Write-Host " Done." -ForegroundColor Green
Write-Host "======================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Output:       $DistDir"
Write-Host "  Server size:  $([math]::Round($serverSize / 1MB, 1)) MB"
if ($Zip) {
    $zipSize = (Get-Item $ZipPath).Length
    Write-Host "  Zip:          $ZipPath ($([math]::Round($zipSize / 1MB, 1)) MB)"
}
Write-Host ""
Write-Host "Install on this (or any Windows) machine:" -ForegroundColor White
Write-Host "  Right-click PowerShell -> 'Run as administrator', then:" -ForegroundColor DarkGray
Write-Host "  cd '$DistDir'" -ForegroundColor DarkGray
Write-Host "  .\installer\install.ps1" -ForegroundColor DarkGray
Write-Host ""
Write-Host "To uninstall later:" -ForegroundColor White
Write-Host "  Add/Remove Programs -> NoteControl, OR" -ForegroundColor DarkGray
Write-Host "  cd 'C:\Program Files\NoteControl' (admin PowerShell)" -ForegroundColor DarkGray
Write-Host "  .\uninstall.ps1" -ForegroundColor DarkGray
Write-Host ""
