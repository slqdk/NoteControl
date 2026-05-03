using System.ComponentModel.DataAnnotations;

namespace NoteControl.Server.Options;

/// <summary>
/// Admin-tunable subset of Serilog's logging configuration. Serilog
/// itself is configured via the "Serilog" section (rich, file
/// rolling, etc.) — these are the *operational* knobs the admin
/// would actually want to change without editing JSON by hand:
/// minimum level + how many days of files to keep.
/// <para>
/// The values here are read by Program.cs at startup AND by
/// IOptionsMonitor consumers if Serilog re-evaluation is wired in
/// later. Today the file rolling defaults still come from
/// appsettings.json — these settings layer on top of them.
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
    /// How many days of rolled log files Serilog should retain.
    /// Surfaced here for admin convenience; the actual retention
    /// is enforced by the file sink in appsettings.json.
    /// </summary>
    [Range(1, 365)]
    public int RetainDays { get; set; } = 30;
}
