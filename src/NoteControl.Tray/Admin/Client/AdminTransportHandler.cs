using System.IO;
using System.Net.Http;

namespace NoteControl.Tray.Admin.Client;

/// <summary>
/// Sits between <see cref="HttpAdminClient"/>'s HttpClients and the
/// shared socket handler and turns transport failures into
/// <see cref="AdminClientException"/>.
/// <para>
/// Why: every admin window catches <see cref="AdminClientException"/>
/// only. A server that's down or restarting (HttpRequestException), a
/// call that ran out of time (TaskCanceledException from
/// HttpClient.Timeout) or a connection dropped mid-body (IOException)
/// escaped those catch blocks, reached the async-void click/timer
/// handlers and took the whole tray down — e.g. the Logs window's
/// auto-refresh during Restart Server, or any window left open across
/// a server restart.
/// </para>
/// <para>
/// The timeout lives here instead of on HttpClient.Timeout because
/// HttpClient's own timeout fires outside the handler chain, where it
/// can't be translated. The response body is buffered here too, so a
/// connection that drops while the body is read is caught as well.
/// Cancellation requested by the caller's own token still surfaces as
/// OperationCanceledException.
/// </para>
/// </summary>
internal sealed class AdminTransportHandler : DelegatingHandler
{
    private readonly TimeSpan _timeout;

    public AdminTransportHandler(HttpMessageHandler inner, TimeSpan timeout)
        : base(inner)
    {
        _timeout = timeout;
    }

    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken cancellationToken)
    {
        using var timeoutCts = new CancellationTokenSource(_timeout);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, timeoutCts.Token);
        HttpResponseMessage? response = null;
        try
        {
            response = await base.SendAsync(request, linked.Token).ConfigureAwait(false);
            await response.Content.LoadIntoBufferAsync().WaitAsync(linked.Token).ConfigureAwait(false);
            return response;
        }
        catch (OperationCanceledException ex) when (!cancellationToken.IsCancellationRequested)
        {
            response?.Dispose();
            throw new AdminClientException(
                $"The NoteControl server didn't answer within {Describe(_timeout)}. " +
                "It may be busy, restarting or stopped — try again in a moment.",
                inner: ex);
        }
        catch (HttpRequestException ex) when (response is not null)
        {
            // Headers arrived, the body didn't.
            response.Dispose();
            throw new AdminClientException(
                "The connection to the NoteControl server was interrupted. (" + ex.Message + ")",
                inner: ex);
        }
        catch (HttpRequestException ex)
        {
            throw new AdminClientException(
                "Can't reach the NoteControl server" +
                (request.RequestUri is { } u ? $" at {u.GetLeftPart(UriPartial.Authority)}" : "") +
                ". It may be stopped or restarting. (" + ex.Message + ")",
                inner: ex);
        }
        catch (IOException ex)
        {
            response?.Dispose();
            throw new AdminClientException(
                "The connection to the NoteControl server was interrupted. (" + ex.Message + ")",
                inner: ex);
        }
    }

    private static string Describe(TimeSpan t) =>
        t.TotalMinutes >= 2 ? $"{t.TotalMinutes:0} minutes" : $"{t.TotalSeconds:0} seconds";
}
