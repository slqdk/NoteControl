using System.Reflection;
using System.Text;
using NoteControl.Server.Data;
using NoteControl.Server.Vaults.Services;
using Microsoft.EntityFrameworkCore;

namespace NoteControl.Server.Vaults.SampleData;

/// <summary>
/// Drops a curated set of sample folders + notes into a vault to
/// showcase what NoteControl can do. Triggered by the tray's
/// "Install Sample Data" button on the Vaults window.
///
/// Sample content is embedded in this assembly via the csproj's
/// <c>EmbeddedResource</c> entries with explicit
/// <c>LogicalName="SampleNotes/Folder/File.md"</c> attributes — see
/// NoteControl.Server.csproj. The slash-separated logical names map
/// directly to relative paths inside the vault, no name-mangling
/// guesswork.
///
/// Behaviour: OVERWRITES files that already exist. Two clicks =
/// same end state. Useful for "reset to demo state". The tray's
/// confirm dialog wording matches.
/// </summary>
public interface ISampleDataInstaller
{
    /// <summary>
    /// Unpack all bundled sample notes into <paramref name="vaultId"/>.
    /// Returns counts for the audit log + UI surface.
    ///
    /// Throws <see cref="VaultException"/> when the vault can't be
    /// resolved or the assembly resources are unexpectedly missing
    /// (which would mean a build packaging mistake).
    /// </summary>
    Task<SampleDataInstallResult> InstallAsync(Guid vaultId, CancellationToken ct = default);
}

/// <summary>
/// Counts surfaced to the caller. <see cref="FilesWritten"/> is the
/// total number of .md files unpacked. <see cref="FoldersCreated"/>
/// counts only folders that didn't already exist.
/// </summary>
public sealed record SampleDataInstallResult(int FilesWritten, int FoldersCreated);

public sealed class SampleDataInstaller : ISampleDataInstaller
{
    /// <summary>
    /// Resource-name prefix that identifies our sample notes.
    /// Matches the <c>LogicalName</c> prefix declared in the csproj.
    /// Anything not under this prefix is ignored — keeps us safe
    /// if the assembly ever embeds other resources.
    /// </summary>
    private const string ResourcePrefix = "SampleNotes/";

    private readonly ServerDbContext _db;
    private readonly IVaultPathResolver _vaultPaths;
    private readonly ILogger<SampleDataInstaller> _log;

    public SampleDataInstaller(
        ServerDbContext db,
        IVaultPathResolver vaultPaths,
        ILogger<SampleDataInstaller> log)
    {
        _db = db;
        _vaultPaths = vaultPaths;
        _log = log;
    }

    public async Task<SampleDataInstallResult> InstallAsync(Guid vaultId, CancellationToken ct = default)
    {
        // Resolve the vault's on-disk root. Same pattern NoteService
        // uses — keeps us inside the vault root no matter what the
        // resource path looks like.
        var vault = await _db.Vaults
            .Where(v => v.Id == vaultId)
            .Select(v => new { v.Path })
            .FirstOrDefaultAsync(ct)
            ?? throw new VaultException("Vault not found.", statusCode: 404);

        var vaultRoot = _vaultPaths.Resolve(vault.Path);
        if (!Directory.Exists(vaultRoot))
        {
            throw new VaultException(
                $"Vault folder is missing on disk: {vaultRoot}",
                statusCode: 409);
        }

        var asm = Assembly.GetExecutingAssembly();
        var resourceNames = asm.GetManifestResourceNames()
            .Where(n => n.StartsWith(ResourcePrefix, StringComparison.Ordinal))
            .ToArray();

        if (resourceNames.Length == 0)
        {
            // Build packaging mistake. Surface it loudly.
            throw new VaultException(
                "No bundled sample notes were found in the server assembly. " +
                "This is a packaging bug — please file an issue.",
                statusCode: 500);
        }

        // Snapshot existing directories so we can count "newly
        // created" folders accurately. Re-installing into a vault
        // that already has the sample folders should report 0.
        var foldersBefore = SnapshotDirectories(vaultRoot);

        var canonicalRoot = Path.GetFullPath(vaultRoot);
        var filesWritten = 0;

        foreach (var name in resourceNames)
        {
            ct.ThrowIfCancellationRequested();

            // Strip the prefix. The remainder is "Folder/File.md"
            // (or just "File.md" for root-of-vault notes; we don't
            // use that today but the code handles it).
            var relative = name[ResourcePrefix.Length..];
            if (string.IsNullOrEmpty(relative))
            {
                _log.LogWarning("Empty sample resource name after prefix: {Name}", name);
                continue;
            }

            // Convert forward slashes to OS-native separators. The
            // logical name uses '/' even on Windows; combining with
            // Path.Combine would mostly work but be inconsistent.
            var nativeRel = relative.Replace('/', Path.DirectorySeparatorChar);
            var absoluteFile = Path.Combine(vaultRoot, nativeRel);

            // Path-traversal guard. The logical names are baked at
            // compile time so a "../" can't actually slip through,
            // but we check anyway — no reason to skip a free safety
            // belt for resources we control.
            var canonicalFile = Path.GetFullPath(absoluteFile);
            if (!canonicalFile.StartsWith(canonicalRoot + Path.DirectorySeparatorChar,
                    StringComparison.OrdinalIgnoreCase) &&
                !canonicalFile.Equals(canonicalRoot, StringComparison.OrdinalIgnoreCase))
            {
                _log.LogWarning(
                    "Refusing sample resource that escapes vault root: {Name} -> {Path}",
                    name, absoluteFile);
                continue;
            }

            var folder = Path.GetDirectoryName(canonicalFile);
            if (!string.IsNullOrEmpty(folder))
            {
                Directory.CreateDirectory(folder);
            }

            // Read the embedded resource as UTF-8 text.
            await using var stream = asm.GetManifestResourceStream(name);
            if (stream is null)
            {
                _log.LogWarning("Embedded resource stream null for {Name}", name);
                continue;
            }

            using var reader = new StreamReader(stream, Encoding.UTF8);
            var body = await reader.ReadToEndAsync(ct);

            // Normalise CRLF -> LF. Visual Studio commits these
            // .md files with CRLF on Windows; the rest of NoteControl
            // writes LF. Keeping LF prevents diff churn the next
            // time the user edits a sample file in the editor.
            body = body.Replace("\r\n", "\n");

            await WriteAtomicAsync(canonicalFile, body, ct);
            filesWritten++;
        }

        // Count newly-created folders.
        var foldersAfter = SnapshotDirectories(vaultRoot);
        var newFolderCount = foldersAfter
            .Except(foldersBefore, StringComparer.OrdinalIgnoreCase)
            .Count();

        _log.LogInformation(
            "Installed sample data into {VaultId}: {Files} files, {Folders} new folders.",
            vaultId, filesWritten, newFolderCount);

        return new SampleDataInstallResult(filesWritten, newFolderCount);
    }

    /// <summary>
    /// Atomic file write: write to <c>{path}.tmp</c>, then rename.
    /// UTF-8 without BOM. Body should already be LF-normalised by
    /// the caller.
    /// </summary>
    private static async Task WriteAtomicAsync(string path, string body, CancellationToken ct)
    {
        var tmp = path + ".tmp";
        var utf8NoBom = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);
        await File.WriteAllTextAsync(tmp, body, utf8NoBom, ct);
        // overwrite=true matches the ship 52 design: re-installing
        // replaces existing files so the demo content can always
        // be reset to a known good state.
        File.Move(tmp, path, overwrite: true);
    }

    /// <summary>
    /// Set of all directories that exist under <paramref name="root"/>
    /// right now. Used to compute "newly created" folder count by
    /// diffing two snapshots. IO failures during enumeration are
    /// swallowed per-directory — partial results are good enough
    /// for this counter.
    /// </summary>
    private static HashSet<string> SnapshotDirectories(string root)
    {
        var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var stack = new Stack<string>();
        stack.Push(root);
        while (stack.Count > 0)
        {
            var dir = stack.Pop();
            set.Add(dir);
            string[] subs;
            try
            {
                subs = Directory.GetDirectories(dir);
            }
            catch
            {
                continue;
            }
            foreach (var s in subs) stack.Push(s);
        }
        return set;
    }
}
