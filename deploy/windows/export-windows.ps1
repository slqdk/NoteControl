<#
.SYNOPSIS
  Export a Windows NoteControl instance (DataRoot) to a zip that
  deploy/linux/import.sh can import into the Linux container.

.DESCRIPTION
  1. Stops the NoteControlServer service so every SQLite database is
     closed and checkpointed (a consistent snapshot).
  2. Zips the whole DataRoot: server.db, config.json, every vault
     folder (notes, assets, .notesapp/ with indexes, templates, trash,
     releases, dashboards). Entry names use forward slashes and UTF-8,
     so Danish characters survive on Linux.
     Skipped: .server\tray.token, .server\server.url (machine-local,
     regenerated on start) and *-shm files (SQLite rebuilds them).
  3. Writes export-manifest.json into the zip (source, time, counts).
  4. Starts the service again - unless -LeaveStopped is given. Use
     -LeaveStopped for the final cut-over, so nobody edits notes on
     Windows after the export.

  Run in an elevated PowerShell (Run as administrator).

.PARAMETER DataRoot
  Defaults to C:\ProgramData\NoteControl\NotesData.

.PARAMETER OutFile
  Defaults to NoteControl-export-<yyyyMMdd-HHmmss>.zip on the desktop.

.PARAMETER ServiceName
  Defaults to NoteControlServer.

.PARAMETER LeaveStopped
  Don't restart the service after the export.

.EXAMPLE
  .\export-windows.ps1
.EXAMPLE
  .\export-windows.ps1 -LeaveStopped -OutFile D:\nc-final.zip
#>
[CmdletBinding()]
param(
    [string]$DataRoot = 'C:\ProgramData\NoteControl\NotesData',
    [string]$OutFile = '',
    [string]$ServiceName = 'NoteControlServer',
    [switch]$LeaveStopped
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

function Write-Step([string]$msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

# --- Preconditions --------------------------------------------------
$principal = New-Object Security.Principal.WindowsPrincipal(
    [Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this script in an elevated PowerShell (Run as administrator).'
}

$DataRoot = [IO.Path]::GetFullPath($DataRoot).TrimEnd('\')
if (-not (Test-Path -LiteralPath (Join-Path $DataRoot '.server\server.db'))) {
    throw "No .server\server.db under '$DataRoot'. Pass -DataRoot <path>."
}

if ([string]::IsNullOrWhiteSpace($OutFile)) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $OutFile = Join-Path ([Environment]::GetFolderPath('Desktop')) "NoteControl-export-$stamp.zip"
}
$OutFile = [IO.Path]::GetFullPath($OutFile)
if ($OutFile.StartsWith($DataRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'OutFile must not be inside DataRoot.'
}
if (Test-Path -LiteralPath $OutFile) { throw "OutFile already exists: $OutFile" }

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
$wasRunning = $false

try {
    # --- 1. Stop the server ----------------------------------------
    if ($null -ne $service -and $service.Status -ne 'Stopped') {
        $wasRunning = $true
        Write-Step "Stopping service $ServiceName"
        Stop-Service -Name $ServiceName -Force
        $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(60))
        # Give SQLite a moment to release its file handles.
        Start-Sleep -Seconds 2
    } elseif ($null -eq $service) {
        Write-Warning "Service '$ServiceName' not found - make sure the server is not running."
    }

    # --- 2. Zip the DataRoot ---------------------------------------
    Write-Step "Zipping $DataRoot"
    $files = Get-ChildItem -LiteralPath $DataRoot -Recurse -Force -File
    $skipped = New-Object System.Collections.Generic.List[string]
    $count = 0
    [long]$bytes = 0

    $zipStream = [IO.File]::Open($OutFile, [IO.FileMode]::CreateNew)
    try {
        $zip = New-Object IO.Compression.ZipArchive($zipStream, [IO.Compression.ZipArchiveMode]::Create)
        try {
            foreach ($f in $files) {
                $rel = $f.FullName.Substring($DataRoot.Length + 1)
                $entryName = $rel.Replace('\', '/')

                if ($entryName -eq '.server/tray.token' -or
                    $entryName -eq '.server/server.url' -or
                    $entryName.EndsWith('-shm')) {
                    $skipped.Add($entryName)
                    continue
                }

                [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                    $zip, $f.FullName, $entryName,
                    [IO.Compression.CompressionLevel]::Fastest)
                $count++
                $bytes += $f.Length
                if (($count % 500) -eq 0) { Write-Host "    $count files..." }
            }

            # Empty folders (user-created folders without notes yet)
            # have no files to carry them, so add explicit directory
            # entries ("name/") for them.
            $emptyDirs = 0
            foreach ($d in (Get-ChildItem -LiteralPath $DataRoot -Recurse -Force -Directory)) {
                if (@(Get-ChildItem -LiteralPath $d.FullName -Force).Count -eq 0) {
                    $rel = $d.FullName.Substring($DataRoot.Length + 1).Replace('\', '/')
                    [void]$zip.CreateEntry($rel + '/')
                    $emptyDirs++
                }
            }

            # --- 3. Manifest ---------------------------------------
            $vaultDirs = @(Get-ChildItem -LiteralPath $DataRoot -Recurse -Force -Directory -Filter '.notesapp' |
                ForEach-Object { $_.Parent.FullName.Substring($DataRoot.Length + 1).Replace('\', '/') })
            $manifest = [ordered]@{
                format        = 'notecontrol-export'
                formatVersion = 1
                exportedAtUtc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
                sourceHost    = $env:COMPUTERNAME
                sourceDataRoot = $DataRoot
                fileCount     = $count
                totalBytes    = $bytes
                emptyFolders  = $emptyDirs
                vaultFolders  = $vaultDirs
                skipped       = $skipped.ToArray()
            }
            $json = $manifest | ConvertTo-Json -Depth 4
            $entry = $zip.CreateEntry('export-manifest.json')
            $w = New-Object IO.StreamWriter($entry.Open(), (New-Object Text.UTF8Encoding($false)))
            try { $w.Write($json) } finally { $w.Dispose() }
        } finally {
            $zip.Dispose()
        }
    } finally {
        $zipStream.Dispose()
    }

    $sizeMb = [math]::Round((Get-Item -LiteralPath $OutFile).Length / 1MB, 1)
    Write-Step "Exported $count files ($([math]::Round($bytes / 1MB, 1)) MB raw, $sizeMb MB zipped)"
    Write-Host "    $OutFile"
    Write-Host "    Vault folders: $($vaultDirs.Count)"
}
finally {
    # --- 4. Restart --------------------------------------------------
    if ($wasRunning) {
        if ($LeaveStopped) {
            Write-Warning "Service $ServiceName left STOPPED (-LeaveStopped)."
        } else {
            Write-Step "Starting service $ServiceName"
            Start-Service -Name $ServiceName
        }
    }
}

Write-Host ''
Write-Host 'Next: copy the zip into the container and run' -ForegroundColor Green
Write-Host '    bash deploy/linux/import.sh /root/<file>.zip' -ForegroundColor Green
