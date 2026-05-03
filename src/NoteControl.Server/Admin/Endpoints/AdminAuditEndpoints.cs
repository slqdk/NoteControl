using NoteControl.Server.Audit.Services;
using NoteControl.Server.Auth;

namespace NoteControl.Server.Admin.Endpoints;

/// <summary>
/// Admin-only endpoints for the Logs window. Two areas:
/// <list type="bullet">
///   <item>Audit log queries (<c>/api/admin/audit</c>): structured
///     events written by <see cref="Audit.IAuditLog"/>.</item>
///   <item>Server log tail (<c>/api/admin/server/logs/tail</c>):
///     read of the most recent Serilog file on disk.</item>
/// </list>
/// </summary>
public static class AdminAuditEndpoints
{
    public static IEndpointRouteBuilder MapAdminAuditEndpoints(this IEndpointRouteBuilder app)
    {
        var audit = app.MapGroup("/api/admin/audit")
            .WithTags("Admin")
            .RequireAdmin();

        audit.MapGet("/", QueryAuditAsync);
        audit.MapGet("/event-types", ListEventTypesAsync);

        var logs = app.MapGroup("/api/admin/server/logs")
            .WithTags("Admin")
            .RequireAdmin();

        logs.MapGet("/tail", TailAsync);

        return app;
    }

    private static async Task<IResult> QueryAuditAsync(
        DateTimeOffset? since,
        DateTimeOffset? until,
        Guid? userId,
        string? eventType,
        int? limit,
        IAuditQueryService audit,
        CancellationToken ct)
    {
        var results = await audit.QueryAsync(
            since, until, userId, eventType, limit ?? 200, ct);
        return Results.Ok(results);
    }

    private static async Task<IResult> ListEventTypesAsync(
        IAuditQueryService audit,
        CancellationToken ct)
    {
        return Results.Ok(await audit.ListEventTypesAsync(ct));
    }

    private static async Task<IResult> TailAsync(
        int? lines,
        IServerLogReader reader,
        CancellationToken ct)
    {
        var result = await reader.TailAsync(lines ?? 500, ct);
        return Results.Ok(result);
    }
}
