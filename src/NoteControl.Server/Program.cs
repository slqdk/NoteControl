using Microsoft.EntityFrameworkCore;
using NoteControl.Server.Admin.Endpoints;
using NoteControl.Server.Assets.Endpoints;
using NoteControl.Server.Assets.Services;
using NoteControl.Server.Audit;
using NoteControl.Server.Auth;
using NoteControl.Server.Auth.Endpoints;
using NoteControl.Server.Auth.Services;
using NoteControl.Server.Data;
using NoteControl.Server.Folders.Endpoints;
using NoteControl.Server.Folders.Services;
using NoteControl.Server.Notes.Endpoints;
using NoteControl.Server.Notes.Services;
using NoteControl.Server.Options;
using NoteControl.Server.Search.Endpoints;
using NoteControl.Server.Search.Services;
using NoteControl.Server.Templates.Endpoints;
using NoteControl.Server.Templates.Services;
using NoteControl.Server.Users;
using NoteControl.Server.Vaults.Endpoints;
using NoteControl.Server.Vaults.Services;
using Serilog;

// Bootstrap logger — only assign if nothing has set Log.Logger yet. The
// default `Log.Logger` is an internal `SilentLogger`; once we configure
// it, the type is `ReloadableLogger` and we leave it alone. This matters
// for tests: WebApplicationFactory<Program> re-executes this top-level
// code for every test class in the same process, and reassigning would
// dispose the previous logger out from under any in-flight test.
if (Log.Logger.GetType().Name == "SilentLogger")
{
    Log.Logger = new LoggerConfiguration()
        .WriteTo.Console()
        .CreateBootstrapLogger();
}

try
{
    var builder = WebApplication.CreateBuilder(args);

    builder.Host.UseWindowsService();
    // preserveStaticLogger: true is critical for test re-runs.
    //
    // The default behaviour of UseSerilog((ctx, lc) => ...) is to freeze
    // the static Log.Logger ReloadableLogger during host build. A
    // ReloadableLogger can only be frozen once; on the second host build
    // in the same process (i.e. the second WebApplicationFactory test
    // class), it throws "The logger is already frozen".
    //
    // With preserveStaticLogger: true, Serilog builds a fresh logger
    // scoped to this host's DI container and leaves Log.Logger alone.
    // In production (one host build per process) the visible behaviour
    // is unchanged.
    builder.Host.UseSerilog(
        (ctx, lc) => lc.ReadFrom.Configuration(ctx.Configuration),
        preserveStaticLogger: true);

    // -------------------------------------------------------------------
    // Layered config: overlay {DataRoot}/.server/config.json on top of
    // appsettings.json + env vars. This is what makes the data folder
    // portable — copy the data folder to a new machine and the new
    // server instance picks up its operational config from inside it.
    //
    // Resolution: we read the DataRoot from whatever is already
    // configured at this point (appsettings.json + env vars). Tests
    // override DataRoot via ConfigureWebHost AFTER this code runs;
    // their in-memory source then takes priority for IOptions binding,
    // but our config.json layer here pointed at the production default
    // path — which doesn't exist in tests, so the optional load is a
    // no-op. Net effect: tests are unaffected.
    //
    // Settings written via the admin UI are persisted by
    // ServerConfigStore to this same file. reloadOnChange=true means
    // IOptionsMonitor<T> consumers see the new values within ~1s.
    // -------------------------------------------------------------------
    var dataRootForConfig = builder.Configuration["Storage:DataRoot"];
    if (!string.IsNullOrWhiteSpace(dataRootForConfig))
    {
        try
        {
            var layeredConfigPath = Path.Combine(
                dataRootForConfig, ".server", "config.json");
            builder.Configuration.AddJsonFile(
                layeredConfigPath,
                optional: true,
                reloadOnChange: true);
        }
        catch
        {
            // Path could be invalid on the current OS (e.g. running
            // tests on Linux with a Windows-shaped default DataRoot)
            // or unreachable. Silently fall back to whatever's
            // already configured — the layered overlay is a "nice
            // to have" on top of appsettings.json, never a hard
            // requirement.
        }
    }

    // -------------------------------------------------------------------
    // Bind address: read the Network section EARLY (before host build)
    // and override Kestrel's URLs so we listen on loopback only by
    // default, or on all IPv4 interfaces when ExposeOnLan is true. This
    // has to happen here because Kestrel binds endpoints at host build
    // time -- IOptionsMonitor changes after that don't move the
    // listening sockets. The Settings UI surfaces this fact and tells
    // the user that network changes need a server restart.
    //
    // Step 44 — IMPORTANT precedence note:
    //   The IConfiguration `Kestrel:Endpoints` section, if present,
    //   OVERRIDES `WebHost.UseUrls`. The pattern below works only
    //   because we deleted the `Kestrel:Endpoints` block from
    //   appsettings.json in step 44. If you ever add it back (or
    //   inherit it from another config source), Kestrel logs a
    //   warning ("Overriding address(es) ...") and binds to the
    //   IConfiguration value, ignoring our UseUrls call here.
    //   Don't reintroduce that block.
    // -------------------------------------------------------------------
    {
        var networkSection = builder.Configuration.GetSection(NetworkOptions.SectionName);
        var exposeOnLan = networkSection.GetValue<bool>("ExposeOnLan", false);
        var port = networkSection.GetValue<int>("Port", 8080);

        // Defensive clamping. If someone hand-edits config.json with a
        // garbage port, we'd otherwise either crash on bind or open
        // something unintended. Validation in ConfigService also
        // catches UI-driven bad values.
        if (port < 1024 || port > 65535) port = 8080;

        var bindHost = exposeOnLan ? "0.0.0.0" : "127.0.0.1";
        builder.WebHost.UseUrls($"http://{bindHost}:{port}");
    }

    // -------------------------------------------------------------------
    // Kestrel: lift the default 30 MB request size cap so large pasted
    // assets (videos, big PDFs) can come through. The actual per-file
    // ceiling is enforced by AssetOptions.MaxUploadBytes inside the
    // upload handler — Kestrel's setting just decides whether the
    // request even gets to our code. We give Kestrel a slightly higher
    // value than the asset cap so the asset code sees the size and can
    // produce a proper 413 problem-detail response (rather than Kestrel
    // closing the connection with a generic error).
    // -------------------------------------------------------------------
    builder.WebHost.ConfigureKestrel(o =>
    {
        // 600 MB. Tracks (ish) the AssetOptions default of 500 MB.
        o.Limits.MaxRequestBodySize = 600L * 1024 * 1024;
    });
    // The same applies to multipart form parsing — it has its own cap
    // independent of Kestrel's body-size cap.
    builder.Services.Configure<Microsoft.AspNetCore.Http.Features.FormOptions>(o =>
    {
        o.MultipartBodyLengthLimit = 600L * 1024 * 1024;
    });

    // -------------------------------------------------------------------
    // Options binding (with validation on startup).
    // -------------------------------------------------------------------
    builder.Services
        .AddOptions<StorageOptions>()
        .Bind(builder.Configuration.GetSection(StorageOptions.SectionName))
        .ValidateDataAnnotations()
        .ValidateOnStart();

    builder.Services
        .AddOptions<SecurityOptions>()
        .Bind(builder.Configuration.GetSection(SecurityOptions.SectionName))
        .ValidateDataAnnotations()
        .ValidateOnStart();

    builder.Services
        .AddOptions<AuthOptions>()
        .Bind(builder.Configuration.GetSection(AuthOptions.SectionName))
        .ValidateDataAnnotations()
        .ValidateOnStart();

    // Smtp / Backup / Logging — new in step 16. These are bound but
    // not validated on start because empty/disabled defaults are
    // acceptable; validation is enforced by ConfigService when the
    // admin saves changes.
    builder.Services
        .AddOptions<SmtpOptions>()
        .Bind(builder.Configuration.GetSection(SmtpOptions.SectionName));

    builder.Services
        .AddOptions<BackupOptions>()
        .Bind(builder.Configuration.GetSection(BackupOptions.SectionName));

    builder.Services
        .AddOptions<LoggingOptions>()
        .Bind(builder.Configuration.GetSection(LoggingOptions.SectionName));

    // NetworkOptions exposes the Network section to the typed
    // IOptions pipeline. Note that the bind ADDRESS is also read
    // raw earlier in this file (before host build) -- that one is
    // mandatory and can't be replaced with IOptions because Kestrel
    // wires its sockets up before DI is alive. The IOptions binding
    // here exists for the rest of the app: ConfigService reads
    // PublicUrl through this, the email composer reads PublicUrl,
    // etc. ValidateDataAnnotations enforces the [Range] on Port.
    builder.Services
        .AddOptions<NetworkOptions>()
        .Bind(builder.Configuration.GetSection(NetworkOptions.SectionName))
        .ValidateDataAnnotations();

    // -------------------------------------------------------------------
    // EF Core: SQLite database at {DataRoot}/.server/server.db
    // -------------------------------------------------------------------
    builder.Services.AddDbContext<ServerDbContext>((sp, options) =>
    {
        var storage = sp.GetRequiredService<Microsoft.Extensions.Options.IOptions<StorageOptions>>().Value;
        var dbDir = Path.Combine(storage.DataRoot, ".server");
        Directory.CreateDirectory(dbDir);
        var dbPath = Path.Combine(dbDir, "server.db");
        options.UseSqlite($"Data Source={dbPath}");
    });

    // -------------------------------------------------------------------
    // Auth services.
    // -------------------------------------------------------------------
    builder.Services.AddSingleton(TimeProvider.System);
    builder.Services.AddSingleton<IPasswordHasher, Argon2idPasswordHasher>();
    builder.Services.AddSingleton<ICsrfKeyProvider, FileCsrfKeyProvider>();
    builder.Services.AddSingleton<ILoginThrottle, LoginThrottle>();
    builder.Services.AddScoped<ISessionService, SessionService>();
    builder.Services.AddScoped<IAuditLog, AuditLog>();
    builder.Services.AddScoped<IPasswordPolicy, PasswordPolicy>();
    builder.Services.AddHttpClient("hibp");

    // Vault services.
    builder.Services.AddSingleton<IVaultPathResolver, VaultPathResolver>();
    builder.Services.AddScoped<IVaultService, VaultService>();
    // Ship 71: ISampleDataInstaller WAS missing from DI registration.
    // Without this, the minimal-API binder fell back to body-binding
    // the `ISampleDataInstaller installer` parameter on the install
    // endpoint, which produced a 415 with no Content-Type (what the
    // tray sent) or a 500 trying to deserialise `{}` into the
    // interface (what curl with Content-Type sent). The actual
    // endpoint code never ran. Scoped because the implementation
    // depends on the scoped ServerDbContext.
    builder.Services.AddScoped<NoteControl.Server.Vaults.SampleData.ISampleDataInstaller,
        NoteControl.Server.Vaults.SampleData.SampleDataInstaller>();

    // Ship 72: IDailyNoteService was missing from DI for the same
    // reason ISampleDataInstaller was — the endpoint file existed
    // and the service class existed, but the DI registration was
    // never added. Scoped because DailyNoteService takes the
    // scoped ServerDbContext + INoteService + ITemplateService.
    builder.Services.AddScoped<NoteControl.Server.DailyNotes.Services.IDailyNoteService,
        NoteControl.Server.DailyNotes.Services.DailyNoteService>();

    // Note services.
    builder.Services.AddSingleton<INotePathResolver, NotePathResolver>();
    builder.Services.AddScoped<INoteService, NoteService>();
    // Note export (markdown → docx). Scoped because it depends on
    // the scoped ServerDbContext for vault root resolution.
    builder.Services.AddScoped<NoteControl.Server.Notes.Export.INoteExportService,
        NoteControl.Server.Notes.Export.NoteExportService>();
    // Markdown export (zip with .md + .assets/). Same scoping rationale.
    builder.Services.AddScoped<NoteControl.Server.Notes.Export.INoteMdExportService,
        NoteControl.Server.Notes.Export.NoteMdExportService>();
    // Note import (single .md or .zip). Scoped — depends on the same
    // db/path resolvers and on the indexer.
    builder.Services.AddScoped<NoteControl.Server.Notes.Import.INoteImportService,
        NoteControl.Server.Notes.Import.NoteImportService>();

    // Folder services. Scoped because FolderService depends on the
    // scoped ServerDbContext (vault root lookup).
    builder.Services.AddScoped<IFolderService, FolderService>();

    // Asset services (image/video/file paste storage).
    builder.Services.Configure<AssetOptions>(builder.Configuration.GetSection("Assets"));
    builder.Services.AddScoped<IAssetService, AssetService>();
    // Ship 98: parallel service for template assets. Same options
    // (size limits, etc.) but writes into .notesapp/templates/X.assets/
    // rather than next to a note.
    builder.Services.AddScoped<ITemplateAssetService, TemplateAssetService>();

    // Template services. Templates are markdown skeletons stored
    // under {vault}/.notesapp/templates/, inserted at cursor via
    // the slash menu.
    builder.Services.AddScoped<ITemplateService, TemplateService>();

    // Startpage services (step 40).
    // - StartpageConfigService is scoped because it depends on the
    //   scoped ServerDbContext (for vault path lookup).
    // - FeedFetcher is singleton so its in-memory cache survives
    //   across requests; it depends only on IHttpClientFactory and
    //   ILogger, both of which are themselves singletons or
    //   captureable.
    // The "feedfetcher" named HttpClient lets HttpClientFactory
    // pool sockets across requests rather than churning. Default
    // SocketsHttpHandler lifetime (2 min) is fine for our cadence.
    builder.Services.AddScoped<NoteControl.Server.Startpage.Services.IStartpageConfigService,
        NoteControl.Server.Startpage.Services.StartpageConfigService>();
    builder.Services.AddSingleton<NoteControl.Server.Startpage.Services.IFeedFetcher,
        NoteControl.Server.Startpage.Services.FeedFetcher>();
    builder.Services.AddHttpClient("feedfetcher");

    // Search / index services.
    //
    // Pool + build state are singletons because both keep per-vault data
    // alive across requests (open SqliteConnections, last-build markers).
    // IndexService and NoteIndexer are scoped because they depend on the
    // scoped ServerDbContext.
    builder.Services.AddSingleton<IIndexConnectionPool, IndexConnectionPool>();
    builder.Services.AddSingleton<IIndexBuildState, IndexBuildState>();
    builder.Services.AddScoped<IIndexService, IndexService>();
    builder.Services.AddScoped<INoteIndexer, NoteIndexer>();

    // Admin/config services (step 16).
    // ServerConfigStore is a singleton — its only mutable state is a
    // SemaphoreSlim guarding writes; the config file path is computed
    // once from StorageOptions at startup.
    builder.Services.AddSingleton<NoteControl.Server.Configuration.IServerConfigStore,
        NoteControl.Server.Configuration.ServerConfigStore>();
    builder.Services.AddScoped<NoteControl.Server.Admin.Services.IConfigService,
        NoteControl.Server.Admin.Services.ConfigService>();
    builder.Services.AddSingleton<NoteControl.Server.Admin.Services.ISmtpTester,
        NoteControl.Server.Admin.Services.SmtpTester>();

    // Ship 93: Caddy integration. CaddyConfigWriter is a thin
    // singleton wrapping (a) atomic file write of the generated
    // Caddyfile and (b) `caddy reload` invocation. Stateless aside
    // from the injected ILogger; safe as a singleton.
    //
    // CaddyfileGenerator is a static class — no DI registration
    // needed. ConfigService composes the two: generates the file
    // contents, asks the writer to put them on disk + reload Caddy.
    builder.Services.AddSingleton<NoteControl.Server.Caddy.CaddyConfigWriter>();

    // Local tray token (step 17). Singleton so the in-memory token
    // is stable for the lifetime of the process. Generated + written
    // to disk in the constructor; we eager-resolve below after the
    // app is built so failures show up at startup, not on first use.
    builder.Services.AddSingleton<NoteControl.Server.Auth.Local.ILocalTrayTokenService,
        NoteControl.Server.Auth.Local.LocalTrayTokenService>();

    // Backups (step 18).
    // VaultLockService: in-memory per-vault advisory lock used by
    // RestoreService to gate writes during a restore. Singleton —
    // the lock state has to live across requests.
    builder.Services.AddSingleton<NoteControl.Server.Backups.IVaultLockService,
        NoteControl.Server.Backups.VaultLockService>();
    // BackupService: engine. Singleton because it owns the run-lock
    // semaphore and the last-run status fields.
    builder.Services.AddSingleton<NoteControl.Server.Backups.Services.IBackupService,
        NoteControl.Server.Backups.Services.BackupService>();
    // RestoreService: scoped because it depends on the scoped
    // ServerDbContext and IIndexService.
    builder.Services.AddScoped<NoteControl.Server.Backups.Services.IRestoreService,
        NoteControl.Server.Backups.Services.RestoreService>();
    // BackupScheduler: hosted service. Wakes up every minute,
    // fires a backup once per day at the configured time.
    builder.Services.AddHostedService<NoteControl.Server.Backups.Services.BackupScheduler>();

    // ServerUrlPublisher: hosted service that writes the bound
    // server URL(s) to {DataRoot}/.server/server.url after Kestrel
    // finishes binding. The tray app reads that file at startup
    // so it can talk to whatever port the user configured, instead
    // of hardcoding 8080. Step 43.
    builder.Services.AddHostedService<NoteControl.Server.Bootstrap.ServerUrlPublisher>();

    // Audit query + Serilog tail (step 19).
    // Both used by the Logs window. AuditQueryService is scoped
    // because it depends on the scoped DbContext; ServerLogReader
    // is singleton (stateless except for IConfiguration).
    builder.Services.AddScoped<NoteControl.Server.Audit.Services.IAuditQueryService,
        NoteControl.Server.Audit.Services.AuditQueryService>();
    builder.Services.AddSingleton<NoteControl.Server.Audit.Services.IServerLogReader,
        NoteControl.Server.Audit.Services.ServerLogReader>();

    // Endpoint filters.
    builder.Services.AddSingleton<RequireAuthFilter>();
    builder.Services.AddSingleton<RequireAdminFilter>();
    builder.Services.AddSingleton<CsrfFilter>();

    // Authentication services. AspNetCore's built-in IAuthenticationService is
    // referenced by Results.Forbid() / Results.Unauthorized() even though we
    // implement our own session auth via SessionResolverMiddleware. Register
    // a no-op scheme so those Results helpers can find a default to forward
    // to; the scheme handler simply writes the appropriate status code.
    builder.Services
        .AddAuthentication("nc-noop")
        .AddScheme<Microsoft.AspNetCore.Authentication.AuthenticationSchemeOptions, NoOpAuthHandler>(
            "nc-noop", _ => { });

    // -------------------------------------------------------------------
    // Standard ASP.NET Core plumbing.
    // -------------------------------------------------------------------
    builder.Services.AddProblemDetails();
    builder.Services.AddEndpointsApiExplorer();
    builder.Services.AddSwaggerGen();

    var app = builder.Build();

    // -------------------------------------------------------------------
    // SPA hosting (step 37).
    //
    // In a packaged build, publish.ps1 copies the Vite output into
    // {ContentRoot}/wwwroot. We probe for it ONCE here, at startup,
    // and decide based on its presence whether to register the
    // static-file middleware + SPA fallback further down.
    //
    // When wwwroot exists:
    //   - UseDefaultFiles() rewrites GET /  →  GET /index.html  (so
    //     it goes through the static-files pipeline and gets the
    //     right Content-Type).
    //   - UseStaticFiles() serves /assets/*, /favicon.ico, etc.
    //   - MapFallbackToFile("index.html") (further down) catches
    //     React Router deep links like /vaults/abc/note?path=foo.md
    //     and returns the SPA shell. Without it, deep links 404 on
    //     hard refresh.
    //
    // When wwwroot is MISSING (typical when running from VS without
    // having published, or running tests):
    //   - We don't register static files or the SPA fallback.
    //   - The "/" handler (further down) returns a small plain-text
    //     status, mirroring the old behaviour, so devs hitting the
    //     API port directly aren't greeted by a 404.
    //   - In real dev work the user hits Vite (port 5173) anyway;
    //     this is just a friendly fallback for the "I poked port
    //     8080 in a browser" case.
    //
    // We do NOT throw if wwwroot is missing — that would break the
    // VS dev workflow where the user hasn't run publish.ps1 and
    // doesn't need the server to host the SPA.
    //
    // The probe runs ONCE at startup, not per-request: re-checking
    // every request would let someone delete wwwroot mid-flight to
    // change behaviour, and we don't want that. publish.ps1 is the
    // single source of truth.
    // -------------------------------------------------------------------
    var wwwrootPath = Path.Combine(app.Environment.ContentRootPath, "wwwroot");
    var spaPresent = File.Exists(Path.Combine(wwwrootPath, "index.html"));

    if (spaPresent)
    {
        Log.Information(
            "SPA assets found at {Wwwroot}; serving frontend from this server.",
            wwwrootPath);
    }
    else
    {
        Log.Warning(
            "SPA assets NOT found at {Wwwroot}. Server will respond to '/' " +
            "with a plain-text status only. This is normal in dev (use Vite at " +
            "http://localhost:5173). For a deployed build, run publish.ps1 to " +
            "produce a dist with wwwroot/ populated.",
            wwwrootPath);
    }

    // -------------------------------------------------------------------
    // Apply migrations + seed bootstrap admin.
    // -------------------------------------------------------------------
    using (var scope = app.Services.CreateScope())
    {
        var db = scope.ServiceProvider.GetRequiredService<ServerDbContext>();
        db.Database.Migrate();
    }
    await AdminBootstrap.EnsureAdminAsync(app.Services);

    // Generate the local tray token + write tray.token at startup
    // (rather than lazily on first use) so the tray app can find
    // it as soon as the server is up, and so any ACL/permission
    // problem surfaces in startup logs not under load.
    _ = app.Services.GetRequiredService<NoteControl.Server.Auth.Local.ILocalTrayTokenService>();

    // Ship 93: write the auto-generated Caddyfile on every server
    // startup so it stays in sync with the current hostname list +
    // backend port. This handles two cases ConfigService.UpdateAsync
    // doesn't:
    //   1. First boot after upgrading from a pre-Ship-93 build —
    //      no save has happened yet, but Caddy needs a Caddyfile
    //      to start.
    //   2. The user edited config.json by hand (rather than via the
    //      Tray Settings UI). Their hand-edit takes effect on next
    //      restart, and the Caddyfile is regenerated to match.
    // We don't try to reload Caddy from here — at startup the user
    // hasn't run setup-https.ps1 yet on first install, and even on
    // subsequent boots the Caddy service starts on its own and
    // reads the latest Caddyfile from disk. No reload needed.
    try
    {
        var network = app.Services.GetRequiredService<
            Microsoft.Extensions.Options.IOptionsMonitor<
                NoteControl.Server.Options.NetworkOptions>>().CurrentValue;
        var caddyWriter = app.Services.GetRequiredService<
            NoteControl.Server.Caddy.CaddyConfigWriter>();
        // Ship 94: hardcoded paths matching setup-https.ps1's
        // deployment convention. See ConfigService.ResolveCaddyfilePath
        // for rationale (the previous Ship 93 design derived these
        // from DataRoot, which produced ...\NotesData\caddy\Caddyfile
        // while the script + service expected one level up).
        var caddyfilePath = @"C:\ProgramData\NoteControl\caddy\Caddyfile";
        var logPath = @"C:\ProgramData\NoteControl\logs\caddy-access.log";
        var contents = NoteControl.Server.Caddy.CaddyfileGenerator.Generate(
            network.PublicHostnames ?? new List<string>(),
            network.Port,
            logPath);
        caddyWriter.Write(caddyfilePath, contents);
    }
    catch (Exception ex)
    {
        // Don't let a Caddyfile-write failure prevent the server
        // from booting. Log loudly; a restart with permissions
        // fixed will recover.
        var startupLog = app.Services.GetRequiredService<
            Microsoft.Extensions.Logging.ILoggerFactory>()
            .CreateLogger("CaddyfileStartup");
        startupLog.LogWarning(ex,
            "Could not generate Caddyfile at startup. The server is " +
            "running normally; HTTPS via Caddy is unaffected only if " +
            "an existing Caddyfile is still on disk.");
    }

    // -------------------------------------------------------------------
    // Middleware pipeline.
    // -------------------------------------------------------------------
    if (app.Environment.IsDevelopment())
    {
        app.UseSwagger();
        app.UseSwaggerUI();
    }
    else
    {
        app.UseExceptionHandler();
        app.UseHsts();
    }

    app.Use(async (context, next) =>
    {
        var headers = context.Response.Headers;
        headers["X-Content-Type-Options"] = "nosniff";
        headers["X-Frame-Options"] = "DENY";
        headers["Referrer-Policy"] = "strict-origin-when-cross-origin";
        headers["Content-Security-Policy"] =
            "default-src 'self'; " +
            "script-src 'self'; " +
            "style-src 'self' 'unsafe-inline'; " +
            "img-src 'self' data:; " +
            "media-src 'self'; " +
            "object-src 'none'; " +
            "frame-ancestors 'none'; " +
            "base-uri 'self'";
        await next();
    });

    app.UseSerilogRequestLogging();

    // Static-files middleware (step 37). Registered AFTER the
    // security-headers middleware so index.html and the JS/CSS
    // bundles ship with CSP/X-Frame-Options/etc, and AFTER Serilog
    // so static-asset hits are visible in request logs. Registered
    // BEFORE SessionResolverMiddleware so asset traffic doesn't pay
    // the cost of session resolution — index.html and /assets/* are
    // public; auth-gating happens client-side after the SPA boots.
    //
    // UseDefaultFiles must come before UseStaticFiles: it rewrites
    // "/" to "/index.html" so static-files knows what to serve.
    if (spaPresent)
    {
        app.UseDefaultFiles();
        app.UseStaticFiles();
    }

    app.UseMiddleware<SessionResolverMiddleware>();

    // VaultLockMiddleware (step 18): rejects writes to a vault while
    // a restore is in progress. Placed after SessionResolver so any
    // user info is available for logging, but before route
    // dispatching so it can read RouteValues.
    app.UseMiddleware<NoteControl.Server.Backups.VaultLockMiddleware>();

    // -------------------------------------------------------------------
    // Endpoints.
    // -------------------------------------------------------------------
    app.MapGet("/health", () => Results.Ok(new
    {
        status = "ok",
        product = "NoteControl",
        version = typeof(Program).Assembly.GetName().Version?.ToString() ?? "0.0.0",
        timestamp = DateTimeOffset.UtcNow
    }))
    .WithName("Health")
    .WithTags("System");

    // Plain-text status at "/" — registered ONLY when the SPA isn't
    // present. In a packaged build, UseDefaultFiles + UseStaticFiles
    // (set up above) handle "/" by serving index.html, and we don't
    // want this handler to win over them. In a dev/no-publish run,
    // this handler is the friendly placeholder for "you hit the API
    // port directly; here's a sign of life."
    if (!spaPresent)
    {
        app.MapGet("/", () => Results.Text(
            "NoteControl Server is running. See /swagger in development.",
            "text/plain"));
    }

    app.MapAuthEndpoints();
    app.MapLocalTokenLoginEndpoint();
    app.MapUserEndpoints();
    app.MapSessionsEndpoints();
    app.MapVaultEndpoints();
    app.MapNoteEndpoints();
    app.MapNoteExportEndpoints();
    app.MapNoteImportEndpoints();
    app.MapFolderEndpoints();
    app.MapSearchEndpoints();
    app.MapFolderRecursiveEndpoints();
    app.MapAssetEndpoints();
    app.MapTemplateEndpoints();
    // Ship 72: daily-note endpoint mapping was missing from Program.cs
    // (the Endpoints class itself existed). Without this, POST to
    // /api/vaults/{id}/daily/today produced a 405 — routing found
    // a path match in MapNoteEndpoints / MapFolderEndpoints (which
    // own everything under /api/vaults/{vaultId}/...) but no method
    // match for POST on this specific subpath, so it returned
    // "method not allowed" instead of 404.
    NoteControl.Server.DailyNotes.Endpoints.DailyNoteEndpoints.MapDailyNoteEndpoints(app);
    NoteControl.Server.Startpage.Endpoints.StartpageEndpoints.MapStartpageEndpoints(app);
    app.MapAdminConfigEndpoints();
    app.MapAdminBackupEndpoints();
    app.MapAdminAuditEndpoints();

    // SPA fallback — registered LAST so all explicit endpoints
    // (above) win for their own paths. This catches anything that
    // isn't an API route AND isn't a real file in wwwroot, and
    // serves index.html so React Router can render the right view
    // client-side. Without this, hard-refreshing a URL like
    // /vaults/abc/note?path=foo.md returns a 404; the route only
    // exists in the React Router config, not in ASP.NET Core's
    // route table.
    //
    // Only registered when wwwroot exists; in dev, /api routes
    // 404 normally on miss and the rest is irrelevant (the user
    // is on Vite's port).
    if (spaPresent)
    {
        app.MapFallbackToFile("index.html");
    }

    app.Run();
}
catch (Exception ex)
{
    Log.Fatal(ex, "NoteControl.Server terminated unexpectedly during startup");
    throw;
}
finally
{
    Log.CloseAndFlush();
}

public partial class Program { }

/// <summary>
/// Authentication scheme that does nothing. Exists only so that
/// Results.Forbid() / Results.Unauthorized() / Results.Challenge() have a
/// default scheme to forward to. Real auth lives in SessionResolverMiddleware.
/// </summary>
internal sealed class NoOpAuthHandler : Microsoft.AspNetCore.Authentication.AuthenticationHandler<Microsoft.AspNetCore.Authentication.AuthenticationSchemeOptions>
{
    public NoOpAuthHandler(
        Microsoft.Extensions.Options.IOptionsMonitor<Microsoft.AspNetCore.Authentication.AuthenticationSchemeOptions> options,
        Microsoft.Extensions.Logging.ILoggerFactory logger,
        System.Text.Encodings.Web.UrlEncoder encoder)
        : base(options, logger, encoder) { }

    protected override Task<Microsoft.AspNetCore.Authentication.AuthenticateResult> HandleAuthenticateAsync()
        => Task.FromResult(Microsoft.AspNetCore.Authentication.AuthenticateResult.NoResult());

    protected override Task HandleChallengeAsync(Microsoft.AspNetCore.Authentication.AuthenticationProperties properties)
    {
        Response.StatusCode = StatusCodes.Status401Unauthorized;
        return Task.CompletedTask;
    }

    protected override Task HandleForbiddenAsync(Microsoft.AspNetCore.Authentication.AuthenticationProperties properties)
    {
        Response.StatusCode = StatusCodes.Status403Forbidden;
        return Task.CompletedTask;
    }
}
