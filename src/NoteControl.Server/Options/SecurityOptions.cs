using System.ComponentModel.DataAnnotations;

namespace NoteControl.Server.Options;

/// <summary>
/// Security-related tunables. Binds to the "Security" section of
/// appsettings.json. Values here are placeholders for future auth work;
/// no code currently consumes them.
/// </summary>
public sealed class SecurityOptions
{
    public const string SectionName = "Security";

    [Range(8, 256)]
    public int MinimumPasswordLength { get; set; } = 12;

    [Range(1, 168)]
    public int SessionIdleTimeoutHours { get; set; } = 12;

    [Range(1, 720)]
    public int SessionAbsoluteTimeoutHours { get; set; } = 168;

    [Range(1, 100)]
    public int LoginAttemptsPerIpPerMinute { get; set; } = 5;

    [Range(1, 1000)]
    public int AccountLockoutThreshold { get; set; } = 10;

    [Range(1, 1440)]
    public int AccountLockoutMinutes { get; set; } = 60;
}
