using NoteControl.Server.DailyNotes.Services;
using NoteControl.Server.Vaults;

namespace NoteControl.Server.DailyNotes.Endpoints;

/// <summary>
/// HTTP surface for daily notes.
///
/// The single endpoint <c>POST /api/vaults/{id}/daily/today</c>
/// is idempotent: it always returns today's note, creating it on
/// the first call of the day. The response tells the client
/// whether creation occurred so it can show a friendly message.
///
/// Requires editor role on the vault.
/// </summary>
public static class DailyNoteEndpoints
{
    public static IEndpointRouteBuilder MapDailyNoteEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/vaults/{vaultId:guid}");

        group.MapPost("/daily/today", OpenTodayAsync)
            .WithName("OpenDailyNoteToday")
            .RequireVault("editor");

        return app;
    }

    private static async Task<IResult> OpenTodayAsync(
        Guid vaultId,
        IDailyNoteService daily,
        CancellationToken ct)
    {
        try
        {
            var resp = await daily.OpenOrCreateTodayAsync(vaultId, ct);
            return Results.Ok(resp);
        }
        catch (DailyNoteException ex)
        {
            return Results.Problem(
                title: "Could not open today's note",
                detail: ex.Message,
                statusCode: ex.StatusCode);
        }
    }
}
