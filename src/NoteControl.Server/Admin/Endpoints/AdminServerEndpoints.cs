using System.Runtime.InteropServices;
using Microsoft.Extensions.Hosting.Systemd;
using NoteControl.Server.Audit;
using NoteControl.Server.Auth;

namespace NoteControl.Server.Admin.Endpoints;

/// <summary>
/// Linux-5: server facts + restart for Administration -> Settings
/// (replaces the tray's Start/Stop/Restart and About window).
///
///   GET  /api/admin/server/info     version, uptime, OS, trusted proxies,
///                                   whether a restart is possible
///   POST /api/admin/server/restart  exit with code 75; systemd restarts
///                                   the service (RestartForceExitStatus=75
///                                   in notecontrol.service)
/// </summary>
public static class AdminServerEndpoints
{
    /// <summary>
    /// Exit code meaning "please restart me". notecontrol.service lists
    /// it in SuccessExitStatus (not logged as a failure) and
    /// RestartForceExitStatus (always restarted).
    /// </summary>
    public const int RestartExitCode = 75;

    private static readonly DateTimeOffset StartedAt = DateTimeOffset.UtcNow;

    public static IEndpointRouteBuilder MapAdminServerEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/admin/server")
            .WithTags("Admin")
            .RequireAdmin();

        group.MapGet("/info", Info);
        group.MapPost("/restart", RestartAsync);

        return app;
    }

    private static IResult Info(IConfiguration config)
    {
        var trusted = config.GetSection("Network:TrustedProxies").Get<List<string>>() ?? new List<string>();
        return Results.Ok(new
        {
            version = typeof(Program).Assembly.GetName().Version?.ToString() ?? "0.0.0",
            build = ReadBuildStamp(),
            startedAt = StartedAt,
            os = RuntimeInformation.OSDescription,
            runtime = RuntimeInformation.FrameworkDescription,
            machineName = Environment.MachineName,
            processUser = Environment.UserName,
            runningUnderSystemd = SystemdHelpers.IsSystemdService(),
            canRestart = SystemdHelpers.IsSystemdService(),
            trustedProxies = trusted,
        });
    }

    private static async Task<IResult> RestartAsync(
        HttpContext http,
        IHostApplicationLifetime lifetime,
        IAuditLog audit)
    {
        if (!SystemdHelpers.IsSystemdService())
        {
            return Results.Problem(
                statusCode: 409,
                title: "Restart from the web UI only works when the server runs as the systemd service.");
        }

        var user = http.RequireUser();
        await audit.WriteAsync(
            AuditEventTypes.ServerRestartRequested,
            user.Id,
            http.GetClientIp(),
            null,
            CancellationToken.None);

        // Let this response reach the browser first, then stop. The
        // exit code tells systemd to start the service again.
        _ = Task.Run(async () =>
        {
            await Task.Delay(TimeSpan.FromSeconds(1));
            Environment.ExitCode = RestartExitCode;
            lifetime.StopApplication();
        });

        return Results.Accepted(value: new { restarting = true });
    }

    /// <summary>VERSION.txt written by deploy/linux/install.sh: "git describe" + build time.</summary>
    private static string? ReadBuildStamp()
    {
        try
        {
            var path = Path.Combine(AppContext.BaseDirectory, "VERSION.txt");
            if (!File.Exists(path)) return null;
            var lines = File.ReadAllLines(path).Where(l => l.Trim().Length > 0).ToArray();
            return lines.Length switch
            {
                0 => null,
                1 => lines[0].Trim(),
                _ => $"{lines[0].Trim()} ({lines[1].Trim()})",
            };
        }
        catch
        {
            return null;
        }
    }
}
