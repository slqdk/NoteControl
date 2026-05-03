using System.ComponentModel.DataAnnotations;

namespace NoteControl.Server.Options;

/// <summary>
/// Backup target + schedule + retention. This ship only PERSISTS
/// these values — the actual backup runner (scheduler + run-now +
/// restore) lands in the next ship's Backups window.
/// <para>
/// The backup target is intentionally a plain filesystem path
/// (external drive or NAS share). Cloud upload is out of scope —
/// users who want it can layer restic / Backblaze on top of the
/// local copy themselves, consistent with the project's
/// "data is plain files on disk" principle.
/// </para>
/// </summary>
public sealed class BackupOptions
{
    public const string SectionName = "Backup";

    /// <summary>
    /// When true, the (future) scheduler runs daily at the
    /// configured time. False today — no scheduler runs even if
    /// this is true; the value just persists for later.
    /// </summary>
    public bool Enabled { get; set; } = false;

    /// <summary>
    /// Where copied vault folders go. May be a UNC path
    /// (\\nas\backups\notecontrol\) or a local drive path
    /// (D:\Backups\NoteControl\). Empty = unset.
    /// </summary>
    public string TargetPath { get; set; } = string.Empty;

    /// <summary>
    /// Time of day for the scheduled run, 24h (e.g. "03:30").
    /// Default early morning so it doesn't fight with active use.
    /// </summary>
    [RegularExpression(@"^([01]\d|2[0-3]):[0-5]\d$",
        ErrorMessage = "Daily time must be HH:MM (24h).")]
    public string DailyTime { get; set; } = "03:30";

    /// <summary>How many recent daily backups to keep on disk.</summary>
    [Range(1, 365)]
    public int RetainDailyCount { get; set; } = 7;

    /// <summary>How many weekly backups to keep, in addition to dailies.</summary>
    [Range(0, 52)]
    public int RetainWeeklyCount { get; set; } = 4;
}
