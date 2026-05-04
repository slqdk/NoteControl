<#
.SYNOPSIS
  Build a self-contained, versioned NoteControl distribution.
  Optionally tag + publish a GitHub Release in one step.

.DESCRIPTION
  Produces dist\NoteControl-<Version>\ containing the published
  server (with the React frontend inlined into wwwroot\), the tray
  app, and a VERSION.txt. Everything in the dist folder is what
  gets shipped -- manually copied to a target machine, or wrapped
  by an installer in a later step.

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
      VERSION.txt                   Just the version string + git SHA

  Optionally produces dist\NoteControl-<Version>.zip alongside
  the folder if -Zip is passed.

  Optionally tags + pushes + publishes a GitHub Release if
  -Release is passed (implies -Zip; you can't release without an
  asset to attach).

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
  easy hand-distribution.

.PARAMETER SkipFrontend
  Switch -- skip the npm build step. Useful if you've already
  built the frontend and just want to re-publish backend code
  faster.

.PARAMETER SkipTray
  Switch -- skip the tray publish. Useful for server-only iteration.

.PARAMETER Release
  Switch -- after a successful build, create a git tag (vX.Y.Z),
  push it to origin, and publish a GitHub Release with the zip
  attached. Implies -Zip. Requires `gh` CLI on PATH and authed
  (`gh auth status` must pass). Refuses to run if the working
  tree is dirty -- the release MUST match what's on GitHub, no
  exceptions.

  The tray's in-app updater finds new versions by polling
  https://api.github.com/repos/slqdk/NoteControl/releases/latest,
  so this is the one-button "ship a new version to all
  installed instances" path.

  The release is created with title "Release X.Y.Z" and an empty
  body. Edit on github.com afterwards if you want to add release
  notes -- the tray's update window shows whatever's there.

.PARAMETER Prerelease
  Switch -- if set with -Release, the GitHub Release is marked
  pre-release. The tray's updater still picks these up (we use
  /releases/latest by default, which excludes prereleases unless
  the latest IS a prerelease). For staged rollouts, mark a build
  prerelease, test it, then publish a non-prerelease build.

.EXAMPLE
  .\publish.ps1 -Version 1.0.0
  Build dist\NoteControl-1.0.0\ in Release mode.

.EXAMPLE
  .\publish.ps1 -Version 1.0.0-rc1 -Zip
  Build the dist folder AND a zip alongside it.

.EXAMPLE
  .\publish.ps1 -Version 0.2.5 -Release
  Build, zip, tag v0.2.5, push the tag, and publish a GitHub
  Release with the zip attached. The tray's in-app updater will
  pick this up within 24h on running installs (or right away
  via Check for updates).

.NOTES
  Run from the repository root. Requires:
    - .NET 8 SDK on PATH (`dotnet --version` should print 8.x)
    - Node + npm on PATH (`node -v`, `npm -v`)
    - The repo's working tree to be clean enough to publish from
      (no lock files held by a running server / tray)
    - For -Release: `gh` CLI on PATH, authed against github.com,
      AND a clean git working tree.

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
    [switch]$SkipTray,

    # Ship 56: GitHub Release publishing.
    [switch]$Release,
    [switch]$Prerelease
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
$DistRoot   = Join-Path $RepoRoot "dist"
$DistDir    = Join-Path $DistRoot "NoteControl-$Version"

# -Release implies -Zip (we need the zip to attach as an asset).
# Setting it here means downstream code doesn't have to worry
# about the corner case of "asked to release but didn't build the
# asset".
if ($Release -and -not $Zip) {
    Write-Host "Note: -Release implies -Zip. Enabling zip output." -ForegroundColor DarkYellow
    $Zip = $true
}

Write-Host ""
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host " NoteControl publish: v$Version ($Configuration / $Runtime)" -ForegroundColor Cyan
if ($Release) {
    Write-Host " Mode: BUILD + RELEASE to GitHub" -ForegroundColor Cyan
}
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

# Pre-flight checks for -Release. Done UP FRONT (before the slow
# build) so a misconfigured release attempt fails in 5 seconds
# rather than 5 minutes after dotnet publish + npm build.
if ($Release) {
    # gh CLI must be installed -- fail loudly if not. Per the
    # ship 57 design choice, we don't auto-install or fall back
    # to manual web steps; the message tells the user to install
    # gh and try again.
    Test-Tool "gh"

    # gh must also be authed against github.com. The release
    # call would fail otherwise; check now to keep error messages
    # tight.
    try {
        & gh auth status 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "not authed" }
    } catch {
        throw "gh CLI is not authenticated. Run: gh auth login"
    }

    # Working tree must be clean. A release that doesn't match
    # HEAD is an attractive nuisance -- the user installs the
    # zip, looks at the source tree assuming it matches, and gets
    # confused. Refuse loudly.
    Push-Location $RepoRoot
    try {
        $dirty = & git status --porcelain
    } finally {
        Pop-Location
    }
    if ($dirty) {
        Write-Host ""
        Write-Host "Refusing to publish a release: working tree is dirty." -ForegroundColor Red
        Write-Host "Uncommitted changes:" -ForegroundColor Red
        Write-Host $dirty -ForegroundColor Yellow
        Write-Host ""
        Write-Host "Commit, stash, or revert them first. The release zip" -ForegroundColor White
        Write-Host "must match what's on GitHub at the tagged commit." -ForegroundColor White
        throw "Dirty working tree blocks -Release."
    }

    # The tag must not already exist locally OR on the remote.
    # If it does, the user probably re-ran publish with the same
    # version by accident. Better to refuse than to clobber.
    Push-Location $RepoRoot
    try {
        $existingTag = & git tag --list "v$Version"
        if ($existingTag) {
            throw "Tag v$Version already exists locally. Delete it (`git tag -d v$Version`) or pick a new version."
        }
        # `git ls-remote --tags origin v$Version` returns a line if
        # the tag exists on the remote; empty otherwise.
        $remoteTag = & git ls-remote --tags origin "refs/tags/v$Version" 2>$null
        if ($remoteTag) {
            throw "Tag v$Version already exists on origin. Pick a new version."
        }
    } finally {
        Pop-Location
    }
}
Write-Host ""

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
# ---------------------------------------------------------------
$ZipPath = $null
if ($Zip) {
    $ZipPath = Join-Path $DistRoot "NoteControl-$Version.zip"
    if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }
    Write-Host "Creating $ZipPath ..." -ForegroundColor White
    Compress-Archive -Path $DistDir -DestinationPath $ZipPath -Force
}

# ---------------------------------------------------------------
# Ship 56: GitHub Release.
# Tag + push + create release with the zip attached. All checks
# done up front; if we got here, gh is installed, authed, the
# tree is clean, and the tag doesn't exist yet.
#
# Title is "Release X.Y.Z", body is empty. The user can edit on
# github.com afterwards -- the tray's update window will show
# whatever's there.
# ---------------------------------------------------------------
if ($Release) {
    Write-Host ""
    Write-Host "------------------------------------------------------" -ForegroundColor Cyan
    Write-Host " Publishing GitHub Release v$Version" -ForegroundColor Cyan
    Write-Host "------------------------------------------------------" -ForegroundColor Cyan

    # Tag at HEAD. Annotated tag (-a) is the convention for
    # release tags so they carry a message + author. The -m
    # value matches the GitHub Release title.
    Push-Location $RepoRoot
    try {
        # Push current branch first. Without this, if local HEAD
        # is ahead of origin (a freshly-committed version bump,
        # for example), the tag we push next will point at a
        # commit that doesn't exist on origin, and gh release
        # create will fail with "no matches found for <sha>"
        # because gh resolves --target against origin's commits.
        #
        # `git push` with no args pushes the CURRENT branch to
        # its tracked upstream. Safe -- we already verified the
        # working tree is clean in the pre-flight checks. If
        # there's nothing to push, this is a fast no-op.
        Write-Host "Pushing current branch to origin..." -ForegroundColor White
        & git push
        if ($LASTEXITCODE -ne 0) { throw "git push (branch) failed" }

        Write-Host "Creating annotated git tag v$Version at HEAD..." -ForegroundColor White
        & git tag -a "v$Version" -m "Release $Version"
        if ($LASTEXITCODE -ne 0) { throw "git tag failed" }

        Write-Host "Pushing tag to origin..." -ForegroundColor White
        & git push origin "v$Version"
        if ($LASTEXITCODE -ne 0) { throw "git push (tag) failed" }
    } finally {
        Pop-Location
    }

    # Build the gh release create command.
    #
    # Two non-obvious choices:
    #
    # 1. Empty notes via a temp file, NOT via --notes "". When you
    #    pass --notes "" through PowerShell, the parser strips the
    #    empty string and gh thinks the value of --notes is the
    #    next flag (--target), which results in a confusing
    #    "no matches found for <sha>" error attributed to the
    #    wrong field. Writing the empty body to a temp file and
    #    using --notes-file dodges the PowerShell quoting issue
    #    entirely.
    #
    # 2. No --target. gh defaults to the repo's default branch
    #    (master), which is what we want anyway -- the tag we
    #    just pushed points at HEAD on master. Earlier attempts
    #    to pass --target with a SHA or a branch name failed for
    #    reasons related to (1) above; dropping the flag avoids
    #    that whole class of issue.
    #
    # Per the ship 57 design choice, the body is intentionally
    # empty -- the user edits on github.com afterwards if they
    # want notes.
    $notesFile = New-TemporaryFile
    try {
        Set-Content -Path $notesFile.FullName -Value "" -Encoding UTF8 -NoNewline

        $ghArgs = @(
            "release", "create", "v$Version",
            $ZipPath,
            "--title", "Release $Version",
            "--notes-file", $notesFile.FullName
        )
        if ($Prerelease) { $ghArgs += "--prerelease" }

        Write-Host "Creating GitHub Release..." -ForegroundColor White
        & gh @ghArgs
        if ($LASTEXITCODE -ne 0) {
            # If the gh call failed we've already pushed the tag.
            # Best-effort cleanup so the next attempt doesn't trip
            # over the existing tag.
            Write-Host "Release creation failed. Rolling back the tag..." -ForegroundColor Red
            try { & git tag -d "v$Version" 2>&1 | Out-Null } catch {}
            try { & git push origin ":refs/tags/v$Version" 2>&1 | Out-Null } catch {}
            throw "gh release create failed."
        }
    } finally {
        if (Test-Path $notesFile.FullName) {
            Remove-Item $notesFile.FullName -Force -ErrorAction SilentlyContinue
        }
    }

    Write-Host ""
    Write-Host "Release v$Version published." -ForegroundColor Green
    Write-Host "  https://github.com/slqdk/NoteControl/releases/tag/v$Version" -ForegroundColor Cyan
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
if ($Release) {
    Write-Host "  Released:     v$Version (https://github.com/slqdk/NoteControl/releases/tag/v$Version)"
}
Write-Host ""
if (-not $Release) {
    Write-Host "Next: copy $DistDir\ to a Windows machine and run:" -ForegroundColor White
    Write-Host "  cd server" -ForegroundColor DarkGray
    Write-Host "  .\NoteControl.Server.exe" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "Then in another terminal in the same dist folder:" -ForegroundColor White
    Write-Host "  cd tray" -ForegroundColor DarkGray
    Write-Host "  .\NoteControl.Tray.exe" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "Browser at http://localhost:8080 -- frontend served by the server." -ForegroundColor White
} else {
    Write-Host "Installed instances will see this update on their next" -ForegroundColor White
    Write-Host "auto-poll (within 24h) or via Check for updates." -ForegroundColor White
    Write-Host ""
    Write-Host "Want to add release notes? Open the URL above and edit." -ForegroundColor White
}
Write-Host ""
