using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using NoteControl.Server.Audit;
using NoteControl.Server.Auth.Services;
using NoteControl.Server.Data;
using NoteControl.Server.Options;

namespace NoteControl.Server.Bootstrap;

/// <summary>
/// Linux-4: maintenance commands run from a shell on the server
/// (wrapped by deploy/linux/reset-admin.sh), for when nobody can sign
/// in any more. The command runs inside the normal host — same
/// configuration, database and password hasher as the service — but
/// Program.cs returns before Kestrel starts, so it works while the
/// service is running.
///
///   NoteControl.Server list-users
///   NoteControl.Server reset-password &lt;username&gt;   (new password on stdin;
///                                                    empty line = generate one)
///
/// reset-password also sets the account to active (clears a lockout
/// or disable) and signs the user out everywhere.
/// </summary>
public static class AdminCli
{
    public static readonly string[] Commands = { "list-users", "reset-password" };

    public static bool IsCliInvocation(string[] args)
        => args.Length > 0 && Commands.Contains(args[0], StringComparer.Ordinal);

    /// <summary>Runs the command; returns the process exit code.</summary>
    public static async Task<int> RunAsync(IServiceProvider services, string[] args)
    {
        using var scope = services.CreateScope();
        var sp = scope.ServiceProvider;
        var db = sp.GetRequiredService<ServerDbContext>();

        switch (args[0])
        {
            case "list-users":
            {
                var users = await db.Users.OrderBy(u => u.Username).ToListAsync();
                Console.WriteLine($"{"USERNAME",-24} {"ROLE",-6} {"STATUS",-9} EMAIL");
                foreach (var u in users)
                {
                    Console.WriteLine($"{u.Username,-24} {u.Role,-6} {u.Status,-9} {u.Email}");
                }
                return 0;
            }

            case "reset-password":
            {
                if (args.Length < 2 || string.IsNullOrWhiteSpace(args[1]))
                {
                    Console.Error.WriteLine("Usage: reset-password <username>   (password on stdin)");
                    return 2;
                }
                var username = args[1];
                var user = await db.Users.FirstOrDefaultAsync(u => u.Username == username);
                if (user is null)
                {
                    Console.Error.WriteLine($"No user named '{username}'. Use list-users.");
                    return 3;
                }

                var password = (Console.In.ReadLine() ?? string.Empty).TrimEnd('\r', '\n');
                var generated = false;
                if (password.Length == 0)
                {
                    password = GeneratePassword();
                    generated = true;
                }

                // Only the length rule: the HIBP check needs the network,
                // and this is the "get me back in" path.
                var minLength = sp.GetRequiredService<IOptionsMonitor<AuthOptions>>().CurrentValue.MinimumPasswordLength;
                if (password.Length < minLength)
                {
                    Console.Error.WriteLine($"Password must be at least {minLength} characters.");
                    return 4;
                }

                var hasher = sp.GetRequiredService<IPasswordHasher>();
                user.PasswordHash = hasher.Hash(password);
                var previousStatus = user.Status;
                user.Status = "active";
                await db.SaveChangesAsync();

                await sp.GetRequiredService<ISessionService>().RevokeAllForUserAsync(user.Id);
                await sp.GetRequiredService<IAuditLog>().WriteAsync(
                    AuditEventTypes.PasswordChanged,
                    userId: user.Id,
                    ipAddress: null,
                    details: new { targetUserId = user.Id, via = "cli", previousStatus },
                    CancellationToken.None);

                Console.WriteLine($"Password for '{user.Username}' ({user.Role}) was reset; the account is active and all sessions were ended.");
                if (generated)
                {
                    Console.WriteLine($"New password: {password}");
                }
                return 0;
            }

            default:
                Console.Error.WriteLine($"Unknown command '{args[0]}'.");
                return 2;
        }
    }

    private static string GeneratePassword()
    {
        const string alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
        Span<byte> bytes = stackalloc byte[20];
        System.Security.Cryptography.RandomNumberGenerator.Fill(bytes);
        var chars = new char[bytes.Length];
        for (var i = 0; i < bytes.Length; i++)
        {
            chars[i] = alphabet[bytes[i] % alphabet.Length];
        }
        // Group in fours so it's easy to type: abcd-efgh-...
        return string.Join('-', Enumerable.Range(0, 5).Select(g => new string(chars, g * 4, 4)));
    }
}
