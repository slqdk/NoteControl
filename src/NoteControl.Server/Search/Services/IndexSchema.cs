namespace NoteControl.Server.Search.Services;

/// <summary>
/// SQL definitions for the per-vault index database
/// (<c>{vault}/.notesapp/index.db</c>).
/// <para>
/// Schema is versioned via <c>PRAGMA user_version</c>. If the constant
/// <see cref="SchemaVersion"/> is bumped, IndexService rebuilds the index
/// from disk on next open. Bumping the version is the supported way to
/// invalidate everyone's index after a schema change.
/// </para>
/// </summary>
public static class IndexSchema
{
    /// <summary>
    /// Bump this when the schema changes in a way that requires a rebuild.
    /// </summary>
    public const int SchemaVersion = 1;

    /// <summary>
    /// Pragmas applied on every connection open. WAL mode keeps readers
    /// (search) from blocking writers (indexer); foreign keys must be on
    /// for the <c>tags.note_path</c> cascade to fire.
    /// </summary>
    public const string ConnectionPragmas = """
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
        PRAGMA synchronous = NORMAL;
        """;

    /// <summary>
    /// Full schema. Idempotent — uses IF NOT EXISTS everywhere so it's
    /// safe to run on every open. Only actually creates anything when
    /// <c>user_version = 0</c> (a fresh DB).
    /// </summary>
    public const string CreateAll = """
        CREATE TABLE IF NOT EXISTS notes (
            path        TEXT PRIMARY KEY,
            title       TEXT NOT NULL,
            created     TEXT,
            updated     TEXT NOT NULL,
            body_text   TEXT NOT NULL,
            frontmatter TEXT
        );

        CREATE TABLE IF NOT EXISTS tags (
            note_path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
            tag       TEXT NOT NULL,
            PRIMARY KEY (note_path, tag)
        );

        CREATE INDEX IF NOT EXISTS ix_tags_tag ON tags(tag);

        -- External-content FTS5 table — keeps the body text only inside the
        -- virtual table, mirrored from `notes` via triggers below. This way
        -- we don't store body_text twice on disk.
        CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
            path UNINDEXED,
            title,
            body_text,
            content='notes',
            content_rowid='rowid',
            tokenize='porter unicode61'
        );

        -- Sync triggers. INSERT/UPDATE/DELETE on notes mirror into FTS.
        CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
            INSERT INTO notes_fts(rowid, path, title, body_text)
                VALUES (new.rowid, new.path, new.title, new.body_text);
        END;
        CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
            INSERT INTO notes_fts(notes_fts, rowid, path, title, body_text)
                VALUES ('delete', old.rowid, old.path, old.title, old.body_text);
        END;
        CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
            INSERT INTO notes_fts(notes_fts, rowid, path, title, body_text)
                VALUES ('delete', old.rowid, old.path, old.title, old.body_text);
            INSERT INTO notes_fts(rowid, path, title, body_text)
                VALUES (new.rowid, new.path, new.title, new.body_text);
        END;
        """;
}
