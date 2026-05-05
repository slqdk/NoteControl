# ----------------------------------------------------------------------
#  apply-cleanup.ps1  --  Cleanup Pass 1
#
#  Removes dead files identified during the cleanup audit.
#  Safe to re-run: every step checks for existence before acting.
#  Use -WhatIf for a dry run that prints what would happen but
#  changes nothing.
#
#  Run from the repo root in PowerShell:
#      .\apply-cleanup.ps1            # actually delete
#      .\apply-cleanup.ps1 -WhatIf    # dry run
#
#  ASCII-only with UTF-8 BOM so PowerShell 5.1 (the in-box Windows
#  PowerShell) reads it correctly. Without the BOM PS5.1 treats
#  .ps1 as Windows-1252 which mangles any non-ASCII byte and can
#  silently break path handling.
#
#  This script does NOT call git. Cleanup is staged and committed
#  by you afterwards. Run:
#      git add -A
#      git status
#      git commit -m "Cleanup pass 1: remove dead files"
# ----------------------------------------------------------------------

[CmdletBinding(SupportsShouldProcess = $true)]
param()

$ErrorActionPreference = 'Stop'

# Anchor everything to the repo root regardless of CWD.
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Write-Host ""
Write-Host "NoteControl cleanup pass 1" -ForegroundColor Cyan
Write-Host "Repo root: $RepoRoot" -ForegroundColor Cyan
if ($WhatIfPreference) {
    Write-Host "Mode: DRY RUN (-WhatIf). No changes will be made." -ForegroundColor Yellow
}
Write-Host ""

# Sanity check. Refuse to run unless we're clearly in the repo so
# the script can never accidentally delete things from elsewhere.
if (-not (Test-Path (Join-Path $RepoRoot 'NoteControl.sln'))) {
    Write-Host "ERROR: NoteControl.sln not found next to this script." -ForegroundColor Red
    Write-Host "       Place apply-cleanup.ps1 at the repo root and re-run." -ForegroundColor Red
    exit 1
}

# Warn if Visual Studio is running. Deleting .vs/ while VS is open
# can confuse VS but won't damage source. A warning is enough; we
# don't try to be clever and kill VS.
$vsRunning = Get-Process devenv -ErrorAction SilentlyContinue
if ($vsRunning) {
    Write-Host "WARNING: Visual Studio (devenv.exe) appears to be running." -ForegroundColor Yellow
    Write-Host "         Closing VS before deleting .vs/ is recommended." -ForegroundColor Yellow
    Write-Host "         (The script will continue regardless.)" -ForegroundColor Yellow
    Write-Host ""
}

# Counters used for the summary at the end. Tracking what was
# already gone vs. actually removed lets re-runs print a sensible
# "nothing to do" message instead of looking broken.
$script:RemovedCount = 0
$script:AlreadyGoneCount = 0
$script:FailedCount = 0

# ----------------------------------------------------------------------
# Helper: Remove-IfExists
# ----------------------------------------------------------------------
# Wraps Remove-Item with: existence check, dry-run honor, and an
# explicit "why" line so the script's intent is visible while it
# runs. Recurses for directories. Force=true so read-only files in
# obj/ etc. don't block the delete.
function Remove-IfExists {
    param(
        [Parameter(Mandatory)] [string] $RelativePath,
        [Parameter(Mandatory)] [string] $Reason
    )

    $full = Join-Path $RepoRoot $RelativePath

    if (-not (Test-Path -LiteralPath $full)) {
        Write-Host "  [skip] $RelativePath  (already gone)" -ForegroundColor DarkGray
        $script:AlreadyGoneCount++
        return
    }

    # PSCmdlet.ShouldProcess honours -WhatIf and -Confirm
    # automatically. The first arg is the target shown to the user;
    # the second is the action verb.
    if ($PSCmdlet.ShouldProcess($RelativePath, "Delete ($Reason)")) {
        try {
            Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction Stop
            Write-Host "  [del]  $RelativePath" -ForegroundColor Green
            Write-Host "         reason: $Reason" -ForegroundColor DarkGray
            $script:RemovedCount++
        }
        catch {
            Write-Host "  [FAIL] $RelativePath" -ForegroundColor Red
            Write-Host "         $($_.Exception.Message)" -ForegroundColor Red
            $script:FailedCount++
        }
    }
}

# ----------------------------------------------------------------------
# Phase 1: tracked dead code
# ----------------------------------------------------------------------
# These files are in git but unused. Audit reasons in the README.
Write-Host "Phase 1: dead source files (tracked)" -ForegroundColor Cyan

# Pre-Ship-93 named-pipe IPC. Admin client is fully HTTP now
# (HttpAdminClient.cs); nothing references AdminRequest /
# AdminResponse / AdminMethods / AdminPipe / the IPC ServerStatus
# record anywhere outside this folder.
Remove-IfExists 'src\NoteControl.Shared\Ipc\AdminMessages.cs'  'pre-Ship-93 named-pipe IPC, no references'
Remove-IfExists 'src\NoteControl.Shared\Ipc\AdminPipe.cs'      'pre-Ship-93 named-pipe IPC, no references'
Remove-IfExists 'src\NoteControl.Shared\Ipc\ServerStatus.cs'   'IPC ServerStatus record, unused (ServerController has its own enum)'
# Ipc folder itself once empty.
Remove-IfExists 'src\NoteControl.Shared\Ipc'                   'folder empty after IPC files removed'

# Frontend orphan. Earlier UI design used a flat list; the tree
# view + folder page replaced it. No imports of NoteList anywhere.
Remove-IfExists 'src\NoteControl.Frontend\src\components\NoteList.tsx'  'orphan from earlier UI design, not imported anywhere'

# Stale placeholder READMEs. The "Views" folder readme described a
# layout that never happened (admin windows live in Admin/Windows/);
# the tray Resources readme described a setup that's already done.
Remove-IfExists 'src\NoteControl.Tray\Views\README.md'         'stale placeholder, layout never adopted'
Remove-IfExists 'src\NoteControl.Tray\Views'                   'folder empty after README removed'
Remove-IfExists 'src\NoteControl.Tray\Resources\README.md'     'stale - tray.ico already in place and registered in csproj'

# Empty stub at repo root. Created when someone ran npm install
# in the repo root by mistake. There is no package.json next to
# it. The real frontend lock is src\NoteControl.Frontend\package-lock.json.
Remove-IfExists 'package-lock.json'                            'empty stub from accidental root npm install'

# Empty directories with literal "{...}" names from a botched
# shell glob. Contain no files at any depth.
Remove-IfExists 'src\{NoteControl.Server'                      'empty dir from a botched shell glob expansion'
Remove-IfExists 'src\{NoteControl.Shared'                      'empty dir from a botched shell glob expansion'

Write-Host ""

# ----------------------------------------------------------------------
# Phase 2: working-tree cruft (gitignored, regenerable)
# ----------------------------------------------------------------------
# These aren't in git but are sitting in your working tree. Each is
# regenerated by the next build / vite dev / etc. Removing them
# cleans up disk space and ensures any cached state from before
# Phase 1 deletes doesn't linger.
Write-Host "Phase 2: regenerable build output and caches" -ForegroundColor Cyan

# Visual Studio per-solution cache. Holds breakpoints and recent
# files; will be recreated when VS is opened next.
Remove-IfExists '.vs'                                          'Visual Studio cache, regenerated on next open'

# Empty root output dir from publish.ps1. Will be recreated on
# next publish run.
Remove-IfExists 'dist'                                         'empty publish output dir, recreated by publish.ps1'

# bin/ and obj/ for each project. dotnet/MSBuild recreates these
# on the next build. Listing them explicitly (rather than a
# wildcard) keeps the script obvious about what it touches.
$BuildOutputs = @(
    'src\NoteControl.Server\bin',
    'src\NoteControl.Server\obj',
    'src\NoteControl.Shared\bin',
    'src\NoteControl.Shared\obj',
    'src\NoteControl.Tray\bin',
    'src\NoteControl.Tray\obj',
    'tests\NoteControl.Tests\bin',
    'tests\NoteControl.Tests\obj'
)
foreach ($p in $BuildOutputs) {
    Remove-IfExists $p 'build output, regenerated by next dotnet build'
}

# Vite tsbuildinfo. Recreated by tsc -b. Not strictly necessary
# to delete (caching makes builds faster) but a stale .tsbuildinfo
# can occasionally confuse tsc after large refactors.
Remove-IfExists 'src\NoteControl.Frontend\tsconfig.tsbuildinfo' 'tsc incremental cache, regenerated on next build'

# Vite production output. Lives in source-control as a build
# artifact only when publish.ps1 runs.
Remove-IfExists 'src\NoteControl.Frontend\dist' 'vite build output, regenerated by next vite build'

Write-Host ""

# Note: we deliberately do NOT delete:
# - node_modules/  (huge; reinstalling takes minutes; let user decide)
# - dev-data/      (real notes/screenshots from local testing)
# - logs/          (might be useful for diagnosing recent issues)
# - appsettings.Development.json (local config)
# - *.user files   (per-user VS state, harmless and per-machine)

# ----------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------
Write-Host "----------------------------------------" -ForegroundColor Cyan
if ($WhatIfPreference) {
    Write-Host "Dry run complete. Re-run without -WhatIf to apply." -ForegroundColor Yellow
} else {
    Write-Host "Cleanup complete." -ForegroundColor Cyan
    Write-Host "  Removed:      $script:RemovedCount" -ForegroundColor Green
    Write-Host "  Already gone: $script:AlreadyGoneCount" -ForegroundColor DarkGray
    if ($script:FailedCount -gt 0) {
        Write-Host "  Failed:       $script:FailedCount" -ForegroundColor Red
    }
    Write-Host ""
    Write-Host "Next steps:" -ForegroundColor Cyan
    Write-Host "  1. git status        # review staged + unstaged deletes" -ForegroundColor Gray
    Write-Host "  2. git add -A        # stage them" -ForegroundColor Gray
    Write-Host "  3. git commit -m 'Cleanup pass 1: remove dead files'" -ForegroundColor Gray
}
Write-Host ""
