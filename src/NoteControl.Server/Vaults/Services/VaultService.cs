using Microsoft.EntityFrameworkCore;
using NoteControl.Server.Data;
using NoteControl.Server.Data.Entities;
using NoteControl.Server.Search.Services;
using NoteControl.Shared.Vaults;

namespace NoteControl.Server.Vaults.Services;

/// <summary>
/// Vault CRUD + permission management. All file-system mutations go through
/// here so the rules (path safety, .notesapp/ creation, permission row
/// alongside the Vault row) live in one place.
/// </summary>
public interface IVaultService
{
    Task<IReadOnlyList<VaultDto>> ListForUserAsync(Guid userId, CancellationToken ct = default);

    /// <summary>
    /// Admin-only "see everything" listing. Returns ALL vaults on the
    /// server, joined with the caller's permission (if any) so MyRole
    /// reflects the caller's actual role on each row, or "none" when
    /// they have no permission on that vault. The endpoint enforces
    /// the admin gate before invoking; the service trusts what it
    /// receives.
    /// </summary>
    Task<IReadOnlyList<VaultDto>> ListAllAsync(Guid callerId, CancellationToken ct = default);

    Task<VaultDto?> GetForUserAsync(Guid vaultId, Guid userId, CancellationToken ct = default);

    /// <summary>
    /// Create a new vault. The Vault row's OwnerId and the corresponding
    /// owner permission row are written for <paramref name="targetOwnerId"/>;
    /// the audit trail (GrantedByUserId) and the on-disk path validation
    /// pivot on whoever the caller asked us to set as owner. The endpoint
    /// is responsible for enforcing that callers can only target a
    /// different owner if they're admin -- the service trusts what it
    /// receives.
    /// </summary>
    Task<VaultDto> CreateAsync(
        Guid callerId,
        Guid targetOwnerId,
        string targetOwnerUsername,
        CreateVaultRequest request,
        CancellationToken ct = default);

    /// <summary>
    /// Adopt an EXISTING on-disk folder as a vault. Mirror of CreateAsync
    /// but the folder MUST already exist (Create rejects if it does;
    /// Register requires it). Creates <c>.notesapp/</c> if missing,
    /// inserts Vault + permission rows. Does NOT rebuild the search
    /// index -- the endpoint kicks that off as a background task after
    /// this returns.
    /// </summary>
    Task<VaultDto> RegisterAsync(
        Guid callerId,
        Guid targetOwnerId,
        string targetOwnerUsername,
        RegisterVaultRequest request,
        CancellationToken ct = default);

    /// <summary>
    /// Delete a vault. Owner-only by default; admins can override with
    /// <paramref name="callerIsAdmin"/>=true. The endpoint resolves
    /// admin status from the HttpContext and passes it through.
    /// </summary>
    Task DeleteAsync(Guid vaultId, Guid callerId, bool callerIsAdmin, CancellationToken ct = default);

    Task<IReadOnlyList<VaultMemberDto>> ListMembersAsync(Guid vaultId, CancellationToken ct = default);

    /// <summary>
    /// Share a vault. Owner-only by default; admins can override with
    /// <paramref name="callerIsAdmin"/>=true.
    /// </summary>
    Task<VaultMemberDto> ShareAsync(Guid vaultId, Guid callerId, bool callerIsAdmin, ShareVaultRequest request, CancellationToken ct = default);

    /// <summary>
    /// Revoke a permission. Owner-only by default; admins can override
    /// with <paramref name="callerIsAdmin"/>=true.
    /// </summary>
    Task UnshareAsync(Guid vaultId, Guid targetUserId, Guid callerId, bool callerIsAdmin, CancellationToken ct = default);

    /// <summary>
    /// Returns the highest role the user holds for the given vault, or null
    /// if they have no access. Used by the RequireVaultRole filter.
    /// </summary>
    Task<string?> GetEffectiveRoleAsync(Guid vaultId, Guid userId, CancellationToken ct = default);

    /// <summary>
    /// Ship 91: set or clear the vault's icon glyph and colour key for
    /// the topbar picker. Both fields can be null individually; null
    /// means "use the auto-derived fallback for that field". The
    /// endpoint enforces the editor-or-owner role gate before calling
    /// (viewers can't rebrand vaults they only read).
    ///
    /// Validates IconKey against the fixed 12-emoji palette and
    /// ColorKey against the 8-name colour palette; unknown values
    /// throw VaultException with statusCode=400. Returns the updated
    /// VaultDto so the client can refresh its in-memory copy without
    /// a separate GET.
    /// </summary>
    Task<VaultDto> UpdateAppearanceAsync(
        Guid vaultId,
        Guid callerId,
        UpdateVaultAppearanceRequest request,
        CancellationToken ct = default);
}

/// <summary>
/// Thrown to indicate a request the caller can fix (bad path, duplicate name,
/// last owner, etc). Mapped to 400 / 409 by the endpoints.
/// </summary>
public sealed class VaultException : Exception
{
    public int StatusCode { get; }
    public VaultException(string message, int statusCode = 400) : base(message) { StatusCode = statusCode; }
    public VaultException(string message, int statusCode, Exception innerException)
        : base(message, innerException) { StatusCode = statusCode; }
}

public sealed class VaultService : IVaultService
{
    public const string RoleOwner = "owner";
    public const string RoleEditor = "editor";
    public const string RoleViewer = "viewer";

    private static readonly HashSet<string> ValidShareRoles = new(StringComparer.OrdinalIgnoreCase)
    {
        RoleEditor, RoleViewer,
    };

    private readonly ServerDbContext _db;
    private readonly IVaultPathResolver _paths;
    private readonly TimeProvider _clock;
    private readonly IIndexConnectionPool _indexPool;

    public VaultService(ServerDbContext db, IVaultPathResolver paths, TimeProvider clock, IIndexConnectionPool indexPool)
    {
        _db = db;
        _paths = paths;
        _clock = clock;
        _indexPool = indexPool;
    }

    public async Task<IReadOnlyList<VaultDto>> ListForUserAsync(Guid userId, CancellationToken ct = default)
    {
        // Join Vaults to permissions on userId. Project owner username via a
        // second join so the DTO is complete in one round-trip.
        var rows = await (from p in _db.VaultPermissions
                          where p.UserId == userId
                          join v in _db.Vaults on p.VaultId equals v.Id
                          join u in _db.Users on v.OwnerId equals u.Id
                          orderby v.Path
                          select new VaultDto(
                              v.Id, v.Path, v.Name, v.Scope, v.OwnerId, u.Username, p.Role, v.CreatedAt,
                              v.IconKey, v.ColorKey))
                         .ToListAsync(ct);
        return rows;
    }

    public async Task<IReadOnlyList<VaultDto>> ListAllAsync(Guid callerId, CancellationToken ct = default)
    {
        // Left-join from every Vault to the caller's VaultPermission for that
        // vault (if any). Vaults without a matching permission row still
        // appear, with MyRole = "none" -- letting admin SEE the vault even
        // though they have no role on it. The endpoint only invokes this
        // for admin callers.
        //
        // EF Core translates the LINQ into a LEFT JOIN; the DefaultIfEmpty
        // pattern is the canonical recipe.
        var rows = await (from v in _db.Vaults
                          join u in _db.Users on v.OwnerId equals u.Id
                          join p in _db.VaultPermissions.Where(p => p.UserId == callerId)
                            on v.Id equals p.VaultId into pp
                          from p in pp.DefaultIfEmpty()
                          orderby v.Path
                          select new VaultDto(
                              v.Id, v.Path, v.Name, v.Scope, v.OwnerId, u.Username,
                              p != null ? p.Role : "none",
                              v.CreatedAt,
                              v.IconKey, v.ColorKey))
                         .ToListAsync(ct);
        return rows;
    }

    public async Task<VaultDto?> GetForUserAsync(Guid vaultId, Guid userId, CancellationToken ct = default)
    {
        return await (from p in _db.VaultPermissions
                      where p.UserId == userId && p.VaultId == vaultId
                      join v in _db.Vaults on p.VaultId equals v.Id
                      join u in _db.Users on v.OwnerId equals u.Id
                      select new VaultDto(
                          v.Id, v.Path, v.Name, v.Scope, v.OwnerId, u.Username, p.Role, v.CreatedAt,
                          v.IconKey, v.ColorKey))
                     .FirstOrDefaultAsync(ct);
    }

    public async Task<VaultDto> CreateAsync(
        Guid callerId,
        Guid targetOwnerId,
        string targetOwnerUsername,
        CreateVaultRequest request,
        CancellationToken ct = default)
    {
        // Determine scope from the path's first segment so the API surface
        // stays simple — the client doesn't have to send scope separately.
        string canonical;
        try
        {
            canonical = _paths.Canonicalize(request.Path);
        }
        catch (InvalidVaultPathException ex)
        {
            throw new VaultException(ex.Message);
        }
        var segments = canonical.Split('/');
        var scope = segments[0] switch
        {
            "users"  => "personal",
            "shared" => "shared",
            _        => throw new VaultException("Vault path must start with 'users/' or 'shared/'."),
        };

        // Re-run with scope-aware checks (validates the username segment
        // against the TARGET OWNER, not necessarily the caller — admin
        // "create on behalf of" sets target = the chosen user).
        string absolute;
        try
        {
            absolute = _paths.ResolveForCreate(canonical, targetOwnerUsername, scope);
        }
        catch (InvalidVaultPathException ex)
        {
            throw new VaultException(ex.Message);
        }

        // Reject duplicate paths.
        if (await _db.Vaults.AnyAsync(v => v.Path == canonical, ct))
        {
            throw new VaultException("A vault already exists at that path.", statusCode: 409);
        }

        // The leaf folder must not already exist on disk — even if there's
        // no Vault row pointing at it. Forces the admin to clean up
        // orphaned folders before reusing the path.
        if (Directory.Exists(absolute))
        {
            throw new VaultException(
                "A folder already exists at that path. Move or delete it first.",
                statusCode: 409);
        }

        var name = string.IsNullOrWhiteSpace(request.Name)
            ? segments[^1]
            : request.Name.Trim();

        var now = _clock.GetUtcNow();
        var vault = new Vault
        {
            Id = Guid.NewGuid(),
            Path = canonical,
            Name = name,
            Scope = scope,
            OwnerId = targetOwnerId,
            CreatedAt = now,
        };

        // Owner permission row. UserId = the chosen owner. GrantedByUserId
        // = the caller (so audit can answer "who created this?" even
        // when the owner isn't the creator).
        var ownerPerm = new VaultPermission
        {
            Id = Guid.NewGuid(),
            VaultId = vault.Id,
            UserId = targetOwnerId,
            Role = RoleOwner,
            GrantedAt = now,
            GrantedByUserId = callerId,
        };

        // Filesystem operation BEFORE the DB write so a disk failure doesn't
        // leave us with a Vault row pointing at nothing. If the DB write
        // fails after we've made the folder, we attempt to clean it up.
        Directory.CreateDirectory(absolute);
        Directory.CreateDirectory(Path.Combine(absolute, ".notesapp"));

        try
        {
            _db.Vaults.Add(vault);
            _db.VaultPermissions.Add(ownerPerm);
            await _db.SaveChangesAsync(ct);
        }
        catch
        {
            // Best-effort cleanup. If this fails too, the operator will
            // see an orphaned folder; logged at the call site.
            try
            {
                if (Directory.Exists(absolute))
                {
                    Directory.Delete(absolute, recursive: true);
                }
            }
            catch { /* swallow */ }
            throw;
        }

        // The MyRole field reflects the CALLER's role. If caller IS the
        // owner, that's "owner". If admin created on behalf of someone
        // else, the caller has no permission row at all, so the role
        // we'd return is "no access" — but the endpoint treats this as
        // a successful create response, so we report "owner" iff the
        // caller actually ended up as owner; otherwise null-equivalent
        // ("none"). Existing behaviour was always "owner" because
        // owner==caller, so this is the new branch.
        var myRole = callerId == targetOwnerId ? RoleOwner : "none";

        // Ship 91: appearance fields default to null on new vault entities,
        // which the client renders as the auto-derived fallback avatar.
        return new VaultDto(
            vault.Id, vault.Path, vault.Name, vault.Scope, vault.OwnerId, targetOwnerUsername, myRole, vault.CreatedAt,
            vault.IconKey, vault.ColorKey);
    }

    public async Task<VaultDto> RegisterAsync(
        Guid callerId,
        Guid targetOwnerId,
        string targetOwnerUsername,
        RegisterVaultRequest request,
        CancellationToken ct = default)
    {
        // The shape of this method intentionally mirrors CreateAsync.
        // Path canonicalisation, scope detection, owner-username
        // validation, name resolution, DB write, all identical. The
        // ONLY differences:
        //   1. The folder must ALREADY exist on disk (Create rejects
        //      if it does; Register requires it).
        //   2. We don't create the leaf folder; we may create
        //      .notesapp/ inside it if missing.
        //   3. Audit / endpoint side: the caller fires a search-index
        //      rebuild after this returns. Not the service's job.
        // Keeping this as a parallel method (rather than collapsing
        // both into one with a flag) makes the difference explicit
        // and the audit-event distinction (vault.created vs
        // vault.registered) trivial.

        string canonical;
        try
        {
            canonical = _paths.Canonicalize(request.Path);
        }
        catch (InvalidVaultPathException ex)
        {
            throw new VaultException(ex.Message);
        }
        var segments = canonical.Split('/');
        var scope = segments[0] switch
        {
            "users"  => "personal",
            "shared" => "shared",
            _        => throw new VaultException("Vault path must start with 'users/' or 'shared/'."),
        };

        string absolute;
        try
        {
            absolute = _paths.ResolveForCreate(canonical, targetOwnerUsername, scope);
        }
        catch (InvalidVaultPathException ex)
        {
            throw new VaultException(ex.Message);
        }

        // Reject duplicate paths (DB row).
        if (await _db.Vaults.AnyAsync(v => v.Path == canonical, ct))
        {
            throw new VaultException("A vault is already registered at that path.", statusCode: 409);
        }

        // Folder MUST exist. This is the key difference from Create.
        if (!Directory.Exists(absolute))
        {
            throw new VaultException(
                $"No folder exists at {absolute}. Copy the folder into the data root first, then register it.",
                statusCode: 404);
        }

        var name = string.IsNullOrWhiteSpace(request.Name)
            ? segments[^1]
            : request.Name.Trim();

        // Ensure .notesapp/ exists. If the folder was created by
        // NoteControl elsewhere it's already there; if the folder
        // was a plain markdown directory (e.g. obsidian or a manual
        // copy of just the notes), it isn't yet. Either way is fine.
        var notesappDir = Path.Combine(absolute, ".notesapp");
        Directory.CreateDirectory(notesappDir);

        var now = _clock.GetUtcNow();
        var vault = new Vault
        {
            Id = Guid.NewGuid(),
            Path = canonical,
            Name = name,
            Scope = scope,
            OwnerId = targetOwnerId,
            // CreatedAt records when the VAULT ROW was created in our
            // DB, not when the folder was created on disk. Honest --
            // an admin registering a 5-year-old vault gets "created
            // just now" in the listing; that's accurate for the row,
            // and the on-disk folder's timestamps are still there if
            // anyone needs them.
            CreatedAt = now,
        };

        var ownerPerm = new VaultPermission
        {
            Id = Guid.NewGuid(),
            VaultId = vault.Id,
            UserId = targetOwnerId,
            Role = RoleOwner,
            GrantedAt = now,
            GrantedByUserId = callerId,
        };

        // No filesystem-rollback path here — we don't create the leaf
        // folder, just .notesapp/ inside an already-existing folder.
        // If the DB write fails, the .notesapp/ we just made is the
        // only side effect, and it's harmless: a re-register attempt
        // will see the folder + .notesapp/ as expected.
        _db.Vaults.Add(vault);
        _db.VaultPermissions.Add(ownerPerm);
        await _db.SaveChangesAsync(ct);

        var myRole = callerId == targetOwnerId ? RoleOwner : "none";

        // Ship 91: appearance fields default to null on new vault entities,
        // which the client renders as the auto-derived fallback avatar.
        return new VaultDto(
            vault.Id, vault.Path, vault.Name, vault.Scope, vault.OwnerId, targetOwnerUsername, myRole, vault.CreatedAt,
            vault.IconKey, vault.ColorKey);
    }

    public async Task DeleteAsync(Guid vaultId, Guid callerId, bool callerIsAdmin, CancellationToken ct = default)
    {
        var vault = await _db.Vaults.FirstOrDefaultAsync(v => v.Id == vaultId, ct)
            ?? throw new VaultException("Vault not found.", statusCode: 404);

        // Ownership check, admin override. The endpoint resolves
        // callerIsAdmin from the HttpContext via http.IsAdmin().
        if (vault.OwnerId != callerId && !callerIsAdmin)
        {
            throw new VaultException("Only the vault owner can delete it.", statusCode: 403);
        }

        // Cascade in DB takes care of VaultPermissions. The on-disk folder
        // we move to a quarantine location rather than hard-delete, so an
        // accidental click is recoverable. We do NOT use the Recycle Bin
        // because the server may run as a service without a desktop session.
        var absolute = _paths.Resolve(vault.Path);
        if (Directory.Exists(absolute))
        {
            // The index pool keeps a long-lived SqliteConnection on
            // <vault>/.notesapp/index.db. Windows refuses to move a
            // directory whose descendants have open exclusive handles
            // (the symptom is "Access to the path '...' is denied" from
            // Directory.Move). Drop the cached connection first so the
            // OS file locks are released; ClearPool inside EvictAsync
            // handles Microsoft.Data.Sqlite's internal pool. After
            // Move the entry is gone and the next access for this
            // vaultId would lazily reopen if anything tried -- but the
            // vault row itself is about to disappear, so nothing will.
            await _indexPool.EvictAsync(vault.Id);

            var quarantineRoot = Path.Combine(
                Path.GetDirectoryName(absolute) ?? absolute,
                ".deleted");
            Directory.CreateDirectory(quarantineRoot);
            var stamp = _clock.GetUtcNow().ToString("yyyyMMdd-HHmmss");
            var quarantinePath = Path.Combine(quarantineRoot, $"{vault.Name}-{stamp}-{vault.Id:N}");

            try
            {
                Directory.Move(absolute, quarantinePath);
            }
            catch (IOException ex)
            {
                // Rare but possible: an external handle (AV scanner, file
                // explorer preview, a future indexer or watcher) is still
                // pinning a file inside the vault. Surface a clearer
                // message than the raw "Access to the path ... is denied"
                // so the user can retry rather than thinking it's a
                // permissions problem with their account.
                throw new VaultException(
                    "Could not move the vault folder to quarantine: a file inside it is in use. " +
                    "Close any program that has notes from this vault open and try again.",
                    statusCode: 409,
                    innerException: ex);
            }
        }

        _db.Vaults.Remove(vault);
        await _db.SaveChangesAsync(ct);
    }

    public async Task<IReadOnlyList<VaultMemberDto>> ListMembersAsync(Guid vaultId, CancellationToken ct = default)
    {
        return await (from p in _db.VaultPermissions
                      where p.VaultId == vaultId
                      join u in _db.Users on p.UserId equals u.Id
                      orderby p.Role, u.Username
                      select new VaultMemberDto(u.Id, u.Username, p.Role, p.GrantedAt, p.GrantedByUserId))
                     .ToListAsync(ct);
    }

    public async Task<VaultMemberDto> ShareAsync(
        Guid vaultId,
        Guid callerId,
        bool callerIsAdmin,
        ShareVaultRequest request,
        CancellationToken ct = default)
    {
        if (!ValidShareRoles.Contains(request.Role))
        {
            throw new VaultException("Role must be 'editor' or 'viewer'.");
        }

        var vault = await _db.Vaults.FirstOrDefaultAsync(v => v.Id == vaultId, ct)
            ?? throw new VaultException("Vault not found.", statusCode: 404);

        // Ownership check, admin override.
        if (vault.OwnerId != callerId && !callerIsAdmin)
        {
            throw new VaultException("Only the vault owner can share it.", statusCode: 403);
        }

        var target = await _db.Users.FirstOrDefaultAsync(u => u.Username == request.Username, ct)
            ?? throw new VaultException($"No such user: {request.Username}.", statusCode: 404);

        if (target.Id == vault.OwnerId)
        {
            throw new VaultException("Owner already has full access.", statusCode: 409);
        }

        var existing = await _db.VaultPermissions
            .FirstOrDefaultAsync(p => p.VaultId == vaultId && p.UserId == target.Id, ct);

        if (existing is not null)
        {
            // Idempotent: changing role re-uses the existing row.
            existing.Role = request.Role;
            existing.GrantedAt = _clock.GetUtcNow();
            existing.GrantedByUserId = callerId;
        }
        else
        {
            existing = new VaultPermission
            {
                Id = Guid.NewGuid(),
                VaultId = vaultId,
                UserId = target.Id,
                Role = request.Role,
                GrantedAt = _clock.GetUtcNow(),
                GrantedByUserId = callerId,
            };
            _db.VaultPermissions.Add(existing);
        }

        await _db.SaveChangesAsync(ct);

        return new VaultMemberDto(target.Id, target.Username, existing.Role, existing.GrantedAt, existing.GrantedByUserId);
    }

    public async Task UnshareAsync(Guid vaultId, Guid targetUserId, Guid callerId, bool callerIsAdmin, CancellationToken ct = default)
    {
        var vault = await _db.Vaults.FirstOrDefaultAsync(v => v.Id == vaultId, ct)
            ?? throw new VaultException("Vault not found.", statusCode: 404);

        // Ownership check, admin override.
        if (vault.OwnerId != callerId && !callerIsAdmin)
        {
            throw new VaultException("Only the vault owner can revoke access.", statusCode: 403);
        }

        if (targetUserId == vault.OwnerId)
        {
            throw new VaultException("Owner access cannot be revoked. Delete the vault or transfer ownership.", statusCode: 400);
        }

        var perm = await _db.VaultPermissions
            .FirstOrDefaultAsync(p => p.VaultId == vaultId && p.UserId == targetUserId, ct);
        if (perm is null)
        {
            // Idempotent.
            return;
        }

        _db.VaultPermissions.Remove(perm);
        await _db.SaveChangesAsync(ct);
    }

    public async Task<string?> GetEffectiveRoleAsync(Guid vaultId, Guid userId, CancellationToken ct = default)
    {
        return await _db.VaultPermissions
            .Where(p => p.VaultId == vaultId && p.UserId == userId)
            .Select(p => p.Role)
            .FirstOrDefaultAsync(ct);
    }

    /// <summary>
    /// Ship 91: validation palettes for the appearance endpoint. The
    /// emoji set is the 12-icon palette the client picker exposes; the
    /// colour set is the 8 named swatches. Server validates against
    /// these so an attacker (or a typo'd payload from a future bug)
    /// can't write garbage values that would render as broken UI.
    ///
    /// If the palettes change, update both this set AND the client's
    /// VaultPicker fixture in lockstep. Mismatches will fail with 400
    /// — the server is the source of truth.
    /// </summary>
    private static readonly HashSet<string> ValidIconKeys = new()
    {
        "📁", "📓", "🛠", "🔧", "💼", "✏️", "📊", "🏠", "🎓", "🎨", "🔬", "📐",
    };

    private static readonly HashSet<string> ValidColorKeys = new(StringComparer.OrdinalIgnoreCase)
    {
        "blue", "green", "orange", "purple", "red", "teal", "amber", "pink",
    };

    public async Task<VaultDto> UpdateAppearanceAsync(
        Guid vaultId,
        Guid callerId,
        UpdateVaultAppearanceRequest request,
        CancellationToken ct = default)
    {
        // Validate palette membership BEFORE touching the DB so a bad
        // request never causes a partial write. Empty string is treated
        // as null — the client's reset path may send "" and that should
        // mean "clear it", not "store empty".
        var icon = string.IsNullOrEmpty(request.IconKey) ? null : request.IconKey;
        var color = string.IsNullOrEmpty(request.ColorKey) ? null : request.ColorKey;

        if (icon is not null && !ValidIconKeys.Contains(icon))
            throw new VaultException($"Unknown icon key '{icon}'.", statusCode: 400);
        if (color is not null && !ValidColorKeys.Contains(color))
            throw new VaultException($"Unknown colour key '{color}'.", statusCode: 400);

        var vault = await _db.Vaults.FirstOrDefaultAsync(v => v.Id == vaultId, ct)
            ?? throw new VaultException("Vault not found.", statusCode: 404);

        vault.IconKey = icon;
        vault.ColorKey = color;
        await _db.SaveChangesAsync(ct);

        // Re-project to a VaultDto using the same join shape as
        // GetForUserAsync. Inlined rather than calling the public method
        // to keep the round-trip count to one — we already have the
        // entity in memory and just need owner username + caller's role.
        var ownerUsername = await _db.Users
            .Where(u => u.Id == vault.OwnerId)
            .Select(u => u.Username)
            .FirstOrDefaultAsync(ct) ?? "(unknown)";
        var myRole = await _db.VaultPermissions
            .Where(p => p.VaultId == vaultId && p.UserId == callerId)
            .Select(p => p.Role)
            .FirstOrDefaultAsync(ct) ?? "none";

        return new VaultDto(
            vault.Id, vault.Path, vault.Name, vault.Scope, vault.OwnerId, ownerUsername, myRole, vault.CreatedAt,
            vault.IconKey, vault.ColorKey);
    }
}
