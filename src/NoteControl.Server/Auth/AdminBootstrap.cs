using System.Security.Cryptography;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using NoteControl.Server.Audit;
using NoteControl.Server.Auth.Services;
using NoteControl.Server.Data;
using NoteControl.Server.Data.Entities;
using NoteControl.Server.Options;

namespace NoteControl.Server.Auth;

/// <summary>
/// Runs on startup. If the user table is empty, creates the configured
/// bootstrap admin so somebody can log in. If no password was supplied via
/// configuration, generates a strong random one and prints it to the server
/// log for the operator to pick up. The admin should change it immediately.
/// </summary>
public static class AdminBootstrap
{
    public static async Task EnsureAdminAsync(IServiceProvider services, CancellationToken ct = default)
    {
        using var scope = services.CreateScope();
        var sp = scope.ServiceProvider;

        var db = sp.GetRequiredService<ServerDbContext>();
        var hasher = sp.GetRequiredService<IPasswordHasher>();
        var audit = sp.GetRequiredService<IAuditLog>();
        var log = sp.GetRequiredService<ILogger<Program>>();
        var auth = sp.GetRequiredService<IOptions<AuthOptions>>().Value;

        var anyUsers = await db.Users.AnyAsync(ct);
        if (anyUsers)
        {
            return;
        }

        var bootstrap = auth.BootstrapAdmin;
        var password = bootstrap.Password;
        var generated = false;
        if (string.IsNullOrEmpty(password))
        {
            password = GenerateRandomPassword(20);
            generated = true;
        }

        var admin = new User
        {
            Id = Guid.NewGuid(),
            Username = bootstrap.Username,
            Email = bootstrap.Email,
            PasswordHash = hasher.Hash(password),
            Role = "admin",
            Status = "active",
            CreatedAt = DateTimeOffset.UtcNow,
        };
        db.Users.Add(admin);
        await db.SaveChangesAsync(ct);

        await audit.WriteAsync(
            AuditEventTypes.AdminBootstrap,
            userId: admin.Id,
            ipAddress: null,
            details: new { username = admin.Username, generated },
            ct);

        if (generated)
        {
            // Loud, single-line, easy-to-grep — operator must capture this on
            // first run. Subsequent restarts won't print it because the user
            // already exists.
            log.LogWarning(
                "BOOTSTRAP ADMIN CREATED: username={Username} email={Email} password={Password} -- change this immediately after first login.",
                admin.Username, admin.Email, password);
        }
        else
        {
            log.LogInformation(
                "Bootstrap admin {Username} created from configured password. You should change it after first login.",
                admin.Username);
        }
    }

    private static string GenerateRandomPassword(int length)
    {
        // Avoid characters that confuse humans reading from a log: 0/O/o/1/l/I.
        const string alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%^&*-_=+";
        Span<byte> bytes = stackalloc byte[length];
        RandomNumberGenerator.Fill(bytes);
        var chars = new char[length];
        for (var i = 0; i < length; i++)
        {
            chars[i] = alphabet[bytes[i] % alphabet.Length];
        }
        return new string(chars);
    }
}
