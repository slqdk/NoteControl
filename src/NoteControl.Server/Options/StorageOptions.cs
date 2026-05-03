using System.ComponentModel.DataAnnotations;

namespace NoteControl.Server.Options;

/// <summary>
/// Where NoteControl stores its data on disk. Binds to the "Storage" section
/// of appsettings.json.
/// </summary>
public sealed class StorageOptions
{
    public const string SectionName = "Storage";

    /// <summary>
    /// Root folder containing users\, shared\ and .server\ subfolders.
    /// In production this is typically on a data drive, e.g. D:\NotesData.
    /// </summary>
    [Required]
    public string DataRoot { get; set; } = string.Empty;
}
