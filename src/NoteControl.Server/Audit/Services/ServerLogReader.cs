using System.Text;
using System.Text.RegularExpressions;
using NoteControl.Shared.Admin;

namespace NoteControl.Server.Audit.Services;

/// <summary>
/// Reads the most recent Serilog file from disk for the Logs
/// window's "Server log" tab. We don't tail it in real-time; the
/// tray polls (manual refresh + an opt-in auto-refresh checkbox).
/// <para>
/// File location is read from configuration. The default install
/// rolls daily files at <c>C:\ProgramData\NoteControl\logs\notecontrol-{date}.log</c>.
/// </para>
/// </summary>
public interface IServerLogReader
{
    /// <summary>
    /// Read up to <paramref name="maxLines"/> from the END of the
    /// most recent log file. Returns parsed lines newest-first so
    /// the tray UI doesn't have to flip the array.
    /// </summary>
    Task<ServerLogTailDto> TailAsync(int maxLines, CancellationToken ct = default);
}

public sealed class ServerLogReader : IServerLogReader
{
    private const int DefaultMaxLines = 500;
    private const int MaxAllowed = 5000;
    // 4 MB read budget. A typical Serilog line is ~150 bytes →
    // ~28k lines. Plenty for any reasonable maxLines, and bounded
    // so we don't OOM on a runaway log file.
    private const long MaxBytesToRead = 4 * 1024 * 1024;

    // Match Serilog's default-ish line shape. Our outputTemplate is:
    //   {Timestamp:yyyy-MM-dd HH:mm:ss.fff zzz} [{Level:u3}] {Message:lj} {Properties:j}{NewLine}{Exception}
    // So a typical line starts with "2026-04-30 14:22:33.123 +02:00 [INF] ...".
    // We pull timestamp + level + the rest as message.
    private static readonly Regex LineRegex = new(
        @"^(?<ts>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} [+\-]\d{2}:\d{2}) \[(?<lvl>[A-Z]{3})\] (?<msg>.*)$",
        RegexOptions.Compiled);

    private static readonly Dictionary<string, string> LevelMap = new(StringComparer.OrdinalIgnoreCase)
    {
        ["VRB"] = "Verbose",
        ["DBG"] = "Debug",
        ["INF"] = "Information",
        ["WRN"] = "Warning",
        ["ERR"] = "Error",
        ["FTL"] = "Fatal",
    };

    private readonly IConfiguration _config;
    private readonly ILogger<ServerLogReader> _log;

    public ServerLogReader(IConfiguration config, ILogger<ServerLogReader> log)
    {
        _config = config;
        _log = log;
    }

    public async Task<ServerLogTailDto> TailAsync(int maxLines, CancellationToken ct = default)
    {
        var clamped = maxLines <= 0 ? DefaultMaxLines : Math.Min(maxLines, MaxAllowed);

        // Resolve the log directory. We read Serilog's File sink path
        // from config. It's a templated path like
        // "...\logs\notecontrol-.log" which Serilog expands to
        // "...\logs\notecontrol-20260430.log". We strip the trailing
        // dash-and-extension to find the directory + file prefix.
        var sinkPath = ResolveSinkPath();
        if (sinkPath is null)
        {
            return new ServerLogTailDto(
                Lines: Array.Empty<ServerLogLineDto>(),
                LogFilePath: null,
                Note: "Could not find a configured Serilog file sink.");
        }

        var dir = Path.GetDirectoryName(sinkPath);
        var filePrefix = Path.GetFileNameWithoutExtension(sinkPath);
        if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir))
        {
            return new ServerLogTailDto(
                Lines: Array.Empty<ServerLogLineDto>(),
                LogFilePath: sinkPath,
                Note: $"Log directory '{dir}' doesn't exist yet.");
        }

        // Pick the newest file matching the configured prefix.
        // E.g. prefix "notecontrol-" → matches "notecontrol-20260430.log".
        var pattern = filePrefix + "*.log";
        var newest = new DirectoryInfo(dir)
            .EnumerateFiles(pattern)
            .OrderByDescending(f => f.LastWriteTimeUtc)
            .FirstOrDefault();
        if (newest is null)
        {
            return new ServerLogTailDto(
                Lines: Array.Empty<ServerLogLineDto>(),
                LogFilePath: null,
                Note: $"No log files matching '{pattern}' in '{dir}'.");
        }

        try
        {
            var lines = await ReadTailAsync(newest.FullName, clamped, ct);
            return new ServerLogTailDto(
                Lines: lines,
                LogFilePath: newest.FullName,
                Note: null);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Failed to read Serilog tail at {Path}", newest.FullName);
            return new ServerLogTailDto(
                Lines: Array.Empty<ServerLogLineDto>(),
                LogFilePath: newest.FullName,
                Note: "Could not read log file: " + ex.Message);
        }
    }

    /// <summary>
    /// Pull the Serilog File sink path from the configuration. We
    /// look at <c>Serilog:WriteTo</c> for the first entry whose Name
    /// is "File" and read its <c>Args:path</c>. If no File sink is
    /// configured (e.g. running under integration tests with only
    /// console logging), returns null.
    /// </summary>
    private string? ResolveSinkPath()
    {
        var writeToSection = _config.GetSection("Serilog:WriteTo");
        foreach (var sink in writeToSection.GetChildren())
        {
            var name = sink["Name"];
            if (string.Equals(name, "File", StringComparison.OrdinalIgnoreCase))
            {
                var path = sink["Args:path"];
                if (!string.IsNullOrWhiteSpace(path)) return path;
            }
        }
        return null;
    }

    /// <summary>
    /// Read the last <paramref name="maxLines"/> lines of a file.
    /// Strategy: read the last <see cref="MaxBytesToRead"/> bytes of
    /// the file, split by newline, take the last N. Coarse but plenty
    /// for the use case ("look at the recent stuff"). Real tail-with-
    /// position-tracking would be overkill.
    /// </summary>
    private static async Task<IReadOnlyList<ServerLogLineDto>> ReadTailAsync(
        string path, int maxLines, CancellationToken ct)
    {
        await using var fs = new FileStream(
            path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        long totalLength = fs.Length;
        long readFrom = Math.Max(0, totalLength - MaxBytesToRead);
        fs.Seek(readFrom, SeekOrigin.Begin);

        // If we landed mid-line, throw away the first partial line
        // we read (it'll be incomplete). Skip if we're at the start.
        var buffer = new byte[totalLength - readFrom];
        var bytesRead = await fs.ReadAsync(buffer.AsMemory(), ct);
        var text = Encoding.UTF8.GetString(buffer, 0, bytesRead);

        // Drop a leading partial line.
        if (readFrom > 0)
        {
            var firstNewline = text.IndexOf('\n');
            if (firstNewline >= 0)
            {
                text = text[(firstNewline + 1)..];
            }
        }

        var rawLines = text.Split('\n');
        var parsed = new List<ServerLogLineDto>(Math.Min(maxLines, rawLines.Length));

        // Walk forward, joining exception continuation lines (they
        // start with whitespace) with the previous parsed line. The
        // result is a "logical" log line per Serilog event.
        ServerLogLineDto? current = null;
        var rolling = new List<ServerLogLineDto>(rawLines.Length);
        foreach (var raw in rawLines)
        {
            var line = raw.TrimEnd('\r');
            if (string.IsNullOrEmpty(line)) continue;

            var match = LineRegex.Match(line);
            if (match.Success)
            {
                if (current is not null) rolling.Add(current);
                if (!DateTimeOffset.TryParse(
                        match.Groups["ts"].Value, out var ts))
                {
                    ts = default;
                }
                var levelStr = match.Groups["lvl"].Value;
                var level = LevelMap.TryGetValue(levelStr, out var l) ? l : levelStr;
                current = new ServerLogLineDto(
                    Timestamp: ts,
                    Level: level,
                    Message: match.Groups["msg"].Value);
            }
            else
            {
                // Continuation (exception trace etc.). Append to
                // current's message.
                if (current is not null)
                {
                    current = current with { Message = current.Message + "\n" + line };
                }
                else
                {
                    // Unparseable line at the start of the buffer —
                    // surface it raw so debugging isn't blind.
                    rolling.Add(new ServerLogLineDto(default, "", line));
                }
            }
        }
        if (current is not null) rolling.Add(current);

        // Take the last `maxLines` and reverse to newest-first.
        var tail = rolling.Count > maxLines
            ? rolling.GetRange(rolling.Count - maxLines, maxLines)
            : rolling;
        tail.Reverse();
        return tail;
    }
}
