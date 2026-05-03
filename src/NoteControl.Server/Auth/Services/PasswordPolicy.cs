using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Options;
using NoteControl.Server.Options;

namespace NoteControl.Server.Auth.Services;

/// <summary>
/// Validates a candidate password against the configured policy. Currently
/// enforces minimum length and (optionally) the HaveIBeenPwned k-anonymity
/// API check. Complexity rules (uppercase / number / symbol) are deliberately
/// omitted: modern guidance is to favour length over composition rules,
/// which encourage predictable substitutions.
/// </summary>
public interface IPasswordPolicy
{
    Task<PasswordValidation> ValidateAsync(string password, CancellationToken ct = default);
}

public sealed record PasswordValidation(bool IsValid, string? Reason);

public sealed class PasswordPolicy : IPasswordPolicy
{
    // Stored as a monitor so config edits land here without a
    // server restart. ValidateAsync snapshots .CurrentValue once
    // per call so all reads see a consistent policy view even if
    // a reload fires mid-method.
    private readonly IOptionsMonitor<AuthOptions> _options;
    private readonly IHttpClientFactory _httpFactory;
    private readonly ILogger<PasswordPolicy> _log;

    public PasswordPolicy(IOptionsMonitor<AuthOptions> options, IHttpClientFactory httpFactory, ILogger<PasswordPolicy> log)
    {
        _options = options;
        _httpFactory = httpFactory;
        _log = log;
    }

    public async Task<PasswordValidation> ValidateAsync(string password, CancellationToken ct = default)
    {
        if (string.IsNullOrEmpty(password))
        {
            return new PasswordValidation(false, "Password is required.");
        }

        var opts = _options.CurrentValue;

        if (password.Length < opts.MinimumPasswordLength)
        {
            return new PasswordValidation(
                false,
                $"Password must be at least {opts.MinimumPasswordLength} characters.");
        }

        if (opts.CheckPasswordAgainstHibp)
        {
            try
            {
                var pwned = await IsPwnedAsync(password, ct);
                if (pwned)
                {
                    return new PasswordValidation(
                        false,
                        "This password has appeared in known data breaches. Please choose a different one.");
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                // Fail open: a flaky network shouldn't block password changes.
                // The minimum length is still enforced.
                _log.LogWarning(ex, "HIBP password check failed; allowing password without that check");
            }
        }

        return new PasswordValidation(true, null);
    }

    /// <summary>
    /// Queries pwnedpasswords.com using the k-anonymity API: only the first
    /// 5 characters of the SHA-1 hash leave the server. Returns true if the
    /// suffix is in the response set.
    /// </summary>
    private async Task<bool> IsPwnedAsync(string password, CancellationToken ct)
    {
        var hash = SHA1HashHex(password);
        var prefix = hash[..5];
        var suffix = hash[5..];

        using var client = _httpFactory.CreateClient("hibp");
        client.DefaultRequestHeaders.UserAgent.ParseAdd("NoteControl/1.0");
        client.Timeout = TimeSpan.FromSeconds(5);

        using var response = await client.GetAsync($"https://api.pwnedpasswords.com/range/{prefix}", ct);
        if (!response.IsSuccessStatusCode)
        {
            return false;
        }

        var body = await response.Content.ReadAsStringAsync(ct);
        foreach (var line in body.Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            var colon = line.IndexOf(':');
            if (colon < 0)
            {
                continue;
            }
            var responseSuffix = line[..colon].Trim();
            if (responseSuffix.Equals(suffix, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }
        return false;
    }

    private static string SHA1HashHex(string s)
    {
        var bytes = Encoding.UTF8.GetBytes(s);
#pragma warning disable CA5350 // SHA-1 is required by the HIBP API contract; not used for security
        var hash = SHA1.HashData(bytes);
#pragma warning restore CA5350
        return Convert.ToHexString(hash);
    }
}
