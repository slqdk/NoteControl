using System.Net;
using System.Net.Mail;
using Microsoft.Extensions.Options;
using NoteControl.Server.Options;

namespace NoteControl.Server.Admin.Services;

/// <summary>
/// Sends a small "this works!" message using the currently-configured
/// SMTP settings. The Settings window calls this when the admin
/// clicks "Test send" so they don't have to wait for a real
/// password-reset to find out the credentials are wrong.
/// </summary>
public interface ISmtpTester
{
    Task<(bool Sent, string? Error)> SendTestAsync(
        string to,
        CancellationToken ct = default);
}

public sealed class SmtpTester : ISmtpTester
{
    private readonly IOptionsMonitor<SmtpOptions> _smtp;
    private readonly ILogger<SmtpTester> _log;

    public SmtpTester(IOptionsMonitor<SmtpOptions> smtp, ILogger<SmtpTester> log)
    {
        _smtp = smtp;
        _log = log;
    }

    public async Task<(bool Sent, string? Error)> SendTestAsync(
        string to,
        CancellationToken ct = default)
    {
        var s = _smtp.CurrentValue;

        // Sanity checks before we touch the network. We give the
        // admin specific messages instead of the generic
        // SmtpException strings so they know what to fix.
        if (string.IsNullOrWhiteSpace(s.Host))
            return (false, "SMTP host is not set. Save settings first.");
        if (string.IsNullOrWhiteSpace(s.FromAddress))
            return (false, "From address is not set. Save settings first.");
        if (string.IsNullOrWhiteSpace(to) || !to.Contains('@'))
            return (false, "Recipient address looks invalid.");

        // System.Net.Mail.SmtpClient is "obsolete in modern code"
        // per the docs (favours MailKit) but it's adequate for a
        // self-hosted notes app's password-reset flow and avoids
        // pulling in another NuGet dependency. If we ever hit one
        // of its known limitations (no OAuth2, etc.), swap to
        // MailKit then.
        try
        {
            using var client = new SmtpClient(s.Host, s.Port);
            client.Timeout = 10_000;

            // Map our string security setting to SmtpClient's
            // EnableSsl flag. STARTTLS and SSL both end up as
            // EnableSsl=true; SmtpClient negotiates the right one
            // based on port + server response.
            client.EnableSsl = !string.Equals(s.Security, "None", StringComparison.OrdinalIgnoreCase);

            if (!string.IsNullOrEmpty(s.Username))
            {
                client.Credentials = new NetworkCredential(s.Username, s.Password);
            }

            using var message = new MailMessage
            {
                From = string.IsNullOrEmpty(s.FromDisplayName)
                    ? new MailAddress(s.FromAddress)
                    : new MailAddress(s.FromAddress, s.FromDisplayName),
                Subject = "NoteControl SMTP test",
                Body =
                    "This is a test message from your NoteControl server.\n\n" +
                    "If you received this, your SMTP settings are working.\n\n" +
                    "Sent at: " + DateTimeOffset.UtcNow.ToString("u"),
                IsBodyHtml = false,
            };
            message.To.Add(to);

            await client.SendMailAsync(message, ct);
            return (true, null);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (SmtpException ex)
        {
            _log.LogWarning(ex, "SMTP test send failed");
            // The status code on SmtpException is a useful hint
            // ("AuthenticationFailed", "MailboxBusy", etc.).
            return (false, $"{ex.StatusCode}: {ex.Message}");
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "SMTP test send failed (non-SMTP)");
            return (false, ex.Message);
        }
    }
}
