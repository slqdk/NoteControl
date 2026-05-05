using System.Text.Json;
using NoteControl.Server.Data;
using NoteControl.Server.Data.Entities;

namespace NoteControl.Server.Audit;

/// <summary>
/// Append-only audit log. Use for any security- or admin-relevant event:
/// logins (success or failure), user creation, permission changes, etc.
/// Writes are best-effort; a logging failure must never break the request
/// that triggered the event.
/// </summary>
public interface IAuditLog
{
    Task WriteAsync(string eventType, Guid? userId, string? ipAddress, object? details = null, CancellationToken ct = default);
}

public sealed class AuditLog : IAuditLog
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private readonly ServerDbContext _db;
    private readonly TimeProvider _clock;
    private readonly ILogger<AuditLog> _log;

    public AuditLog(ServerDbContext db, TimeProvider clock, ILogger<AuditLog> log)
    {
        _db = db;
        _clock = clock;
        _log = log;
    }

    public async Task WriteAsync(
        string eventType,
        Guid? userId,
        string? ipAddress,
        object? details = null,
        CancellationToken ct = default)
    {
        try
        {
            var serialized = details is null ? null : JsonSerializer.Serialize(details, JsonOptions);
            // Truncate to fit the column. Better to lose detail than to fail.
            if (serialized is { Length: > 2048 })
            {
                serialized = serialized[..2048];
            }

            _db.AuditEvents.Add(new AuditEvent
            {
                Timestamp = _clock.GetUtcNow(),
                EventType = eventType,
                UserId = userId,
                IpAddress = ipAddress,
                Details = serialized,
            });
            await _db.SaveChangesAsync(ct);
        }
        catch (Exception ex)
        {
            // Audit must never break the calling request; log loudly so the
            // operator notices a persistent problem.
            _log.LogError(ex, "Audit write failed for event {EventType}", eventType);
        }
    }
}

/// <summary>
/// Canonical event type strings. Centralised so spelling is consistent and
/// querying the table is straightforward.
/// <para>
/// Event types use a dotted hierarchy ("note.created", "vault.shared")
/// so the audit query UI can group / filter by prefix.
/// </para>
/// </summary>
public static class AuditEventTypes
{
    public const string LoginSuccess     = "auth.login.success";
    public const string LoginFailure     = "auth.login.failure";
    public const string LoginLockedOut   = "auth.login.locked_out";
    public const string Logout           = "auth.logout";
    public const string PasswordChanged  = "auth.password.changed";
    public const string SessionRevoked   = "auth.session.revoked";

    public const string UserCreated      = "user.created";
    public const string UserUpdated      = "user.updated";
    public const string UserDeleted      = "user.deleted";

    public const string VaultCreated     = "vault.created";
    public const string VaultRegistered  = "vault.registered";
    public const string VaultDeleted     = "vault.deleted";
    public const string VaultShared      = "vault.shared";
    public const string VaultUnshared    = "vault.unshared";

    // Ship 91: per-vault appearance change (icon glyph + colour swatch
    // for the topbar picker). Cosmetic, low-risk, but worth auditing
    // because the pre-Ship-91 view was "vaults are immutable other
    // than their permissions" — knowing when a name's *visual* shifted
    // helps a future co-editor figure out "wait, why is Beckhoff a
    // chemistry flask now?". Payload includes both old + new keys.
    public const string VaultAppearanceChanged = "vault.appearance.changed";

    // Ship 52: tray's "Install Sample Data" button writes this.
    // Re-running over an existing install (which overwrites files)
    // emits one event per click — useful for distinguishing "user
    // explored the demo content fresh" from "user reset to demo
    // state after editing".
    public const string VaultSampleDataInstalled = "vault.sample_data.installed";

    public const string AdminBootstrap   = "admin.bootstrap";

    // Step 19: structural note ops (deliberately NOT note.updated —
    // autosave-driven updates would balloon the audit table fast).
    public const string NoteCreated      = "note.created";
    public const string NoteDeleted      = "note.deleted";
    public const string NoteMoved        = "note.moved";

    // Step 19: backfilled events from steps 16/18 that should
    // have been audited at the time but weren't.
    public const string ServerConfigUpdated = "admin.server_config.updated";
    public const string BackupRun           = "admin.backup.run";
    public const string BackupRestored      = "admin.backup.restored";
    public const string BackupDeleted       = "admin.backup.deleted";
}
