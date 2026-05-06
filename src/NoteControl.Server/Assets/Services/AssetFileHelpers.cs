namespace NoteControl.Server.Assets.Services;

/// <summary>
/// Filesystem-and-encoding helpers shared by <see cref="AssetService"/>
/// (note assets) and <see cref="TemplateAssetService"/> (template
/// assets). Both services follow the same convention — a sibling
/// <c>.assets/</c> folder, URL-encoded segments in the markdown
/// reference, collision-safe filenames — and the only thing that
/// differs is which folder the assets land in.
///
/// Extracted from <see cref="AssetService"/> in Ship 98 (templates
/// gain image upload). Pre-Ship-98 these methods lived as private
/// statics inside <c>AssetService</c>; the move is mechanical, no
/// behavioural change.
/// </summary>
internal static class AssetFileHelpers
{
    /// <summary>
    /// Strip path separators and characters Windows / Linux can't
    /// use in filenames. Keep dots, dashes, underscores, spaces —
    /// anything reasonable.
    /// </summary>
    public static string SanitiseFileName(string raw)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var sb = new System.Text.StringBuilder(raw.Length);
        foreach (var c in raw)
        {
            if (Array.IndexOf(invalid, c) < 0 && c != '/' && c != '\\')
            {
                sb.Append(c);
            }
        }
        var result = sb.ToString().Trim().TrimStart('.');
        return result;
    }

    /// <summary>
    /// Find a non-colliding filename in the target folder.
    /// "image.png" → "image.png" if free, else "image-2.png",
    /// "image-3.png", ... up to a sane upper bound.
    /// </summary>
    public static string NextAvailableName(string folder, string desired)
    {
        var path = Path.Combine(folder, desired);
        if (!File.Exists(path))
        {
            return desired;
        }

        var stem = Path.GetFileNameWithoutExtension(desired);
        var ext = Path.GetExtension(desired);
        for (int i = 2; i < 10_000; i++)
        {
            var candidate = $"{stem}-{i}{ext}";
            if (!File.Exists(Path.Combine(folder, candidate)))
            {
                return candidate;
            }
        }
        // Fallback — astronomically unlikely. Use a timestamp.
        return $"{stem}-{DateTime.UtcNow:yyyyMMddHHmmssfff}{ext}";
    }

    /// <summary>
    /// URL-encode a single path segment (folder or filename) for use
    /// inside markdown image/link syntax. Uses
    /// <see cref="Uri.EscapeDataString"/> which encodes spaces as
    /// <c>%20</c> and handles other reserved characters per RFC 3986.
    /// We escape DATA (the segment) not a full URL — slashes are not
    /// part of the input here.
    ///
    /// CommonMark's image syntax <c>![alt](url)</c> ends the URL at
    /// the first unescaped space, so any segment containing a space
    /// MUST be encoded for the markdown to round-trip correctly
    /// through load → save → reload.
    /// </summary>
    public static string UrlEncodeSegment(string segment)
    {
        return Uri.EscapeDataString(segment);
    }

    /// <summary>
    /// Map a file extension to a MIME type for the Content-Type
    /// response header. Conservative list — anything unknown gets
    /// <c>application/octet-stream</c> which the browser handles
    /// as a download.
    /// </summary>
    public static string MimeFromExtension(string extension)
    {
        var ext = extension.ToLowerInvariant().TrimStart('.');
        return ext switch
        {
            "png" => "image/png",
            "jpg" or "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "bmp" => "image/bmp",
            "svg" => "image/svg+xml",
            "mp4" => "video/mp4",
            "webm" => "video/webm",
            "mov" => "video/quicktime",
            "mkv" => "video/x-matroska",
            "mp3" => "audio/mpeg",
            "wav" => "audio/wav",
            "ogg" => "audio/ogg",
            "pdf" => "application/pdf",
            "txt" => "text/plain",
            "md" => "text/markdown",
            "json" => "application/json",
            "xml" => "application/xml",
            "csv" => "text/csv",
            "doc" => "application/msword",
            "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "xls" => "application/vnd.ms-excel",
            "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "ppt" => "application/vnd.ms-powerpoint",
            "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "zip" => "application/zip",
            _ => "application/octet-stream",
        };
    }
}
