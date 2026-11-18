using System.ComponentModel.DataAnnotations;

namespace NoteControl.Server.Options;

/// <summary>
/// Admin-tunable subset of Serilog's logging configuration. Serilog
/// itself is configured via the "Serilog" section (rich, file
/// rolling, etc.) — these are the *operational* knobs the admin
/// would actually want to change without editing JSON by hand:
/// minimum level + how many days of files to keep.
/// <para>
/// Applied by Program.cs (Linux-5): MinimumLevel drives a Serilog
/// LoggingLevelSwitch and changes take effect immediately;
/// RetainDays becomes the File sink's retainedFileCountLimit and
/// takes effect at the next server start.
/// </para>
/// </summary>
public sealed class LoggingOptions
{
    public const string SectionName = "Logging";

    /// <summary>
    /// Minimum log level: one of "Verbose", "Debug", "Information",
    /// "Warning", "Error", "Fatal". Stored as a string for
    /// flexibility; validated at the consumption site.
    /// </summary>
    public string MinimumLevel { get; set; } = "Information";

    /// <summary>
    /// How many days of rolled log files Serilog should retain (one
    /// file per day). Applied at server start.
    /// </summary>
    [Range(1, 365)]
    public int RetainDays { get; set; } = 30;

    /// <summary>Parse a level name; unknown/empty falls back to Information.</summary>
    public static Serilog.Events.LogEventLevel ParseLevel(string? value)
        => Enum.TryParse<Serilog.Events.LogEventLevel>(value, ignoreCase: true, out var level)
            ? level
            : Serilog.Events.LogEventLevel.Information;
}
