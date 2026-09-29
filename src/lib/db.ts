import { createClient, type Client } from "@libsql/client";
import { mkdirSync } from "fs";
import path from "path";
import { resolveDatabaseProvider, resolveSetting } from "./appsettings";

/**
 * Database layer for Nightmare Library — provider selected at RUNTIME.
 *
 * Three providers, chosen on the Settings page or auto-detected:
 * - supabase : Supabase Postgres (production) — see supabase.ts
 * - turso    : Turso/libSQL remote SQLite (free 5GB)
 * - local    : SQLite file at .data/nightmare.db (zero-config dev/self-host)
 *
 * Credentials come from the settings table first, env vars second.
 * The libSQL client is re-created when the Turso target changes.
 */

let client: Client | null = null;
let clientTarget: string | null = null;

export function getDb(): Client {
  if (client) return client;

  // Legacy path retained for synchronous callers; new code uses getDbAsync().
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (url) {
    clientTarget = `turso:${url}`;
    client = createClient({ url, authToken });
  } else {
    clientTarget = "local";
    // libSQL does not create parent directories, so ensure .data exists first.
    mkdirSync(path.join(process.cwd(), ".data"), { recursive: true });
    client = createClient({ url: "file:.data/nightmare.db" });
  }

  return client;
}

/** Provider-aware client resolution used by the repo layer. */
export async function getDbAsync(): Promise<Client> {
  const provider = await resolveDatabaseProvider();
  if (provider === "supabase") {
    // Callers check isSupabaseConfigured() first; this branch is a safety net.
    throw new Error("Supabase driver selected — use the Supabase client, not libSQL");
  }

  if (provider === "turso") {
    const url = await resolveSetting("turso_url");
    if (!url) throw new Error("Turso selected but turso_url is not set");
    const authToken = (await resolveSetting("turso_token")) ?? undefined;
    const target = `turso:${url}`;
    if (!client || clientTarget !== target) {
      client = createClient({ url, authToken });
      clientTarget = target;
    }
    return client;
  }

  // local
  if (!client || clientTarget !== "local") {
    mkdirSync(path.join(process.cwd(), ".data"), { recursive: true });
    client = createClient({ url: "file:.data/nightmare.db" });
    clientTarget = "local";
  }
  return client;
}

/** True when the libSQL driver is active (SQLite syntax + file/Turso backend). */
export async function isLibsqlActive(): Promise<boolean> {
  return (await resolveDatabaseProvider()) !== "supabase";
}

/** Runs once per cold start; creates all tables if missing. Single-flight: */
/** concurrent first requests share one migration (a racing ALTER TABLE   */
/** would otherwise throw "duplicate column" and 500 one request).        */
let migrated = false;
let migrationPromise: Promise<void> | null = null;
export async function ensureMigrated(): Promise<void> {
  if (migrated) return;
  if (!migrationPromise) {
    migrationPromise = runMigration()
      .then(() => {
        migrated = true;
      })
      .catch((error) => {
        migrationPromise = null; // allow retry on next request
        throw error;
      });
  }
  return migrationPromise;
}

async function runMigration(): Promise<void> {
  const db = await getDbAsync();

  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS books (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      author TEXT,
      storage_provider TEXT NOT NULL,
      storage_id TEXT NOT NULL,
      cover_url TEXT,
      file_type TEXT NOT NULL,
      file_size INTEGER,
      tags TEXT,
      total_pages INTEGER,
      is_favorite INTEGER DEFAULT 0,
      custom_order INTEGER DEFAULT 0,
      media_type TEXT NOT NULL DEFAULT 'book',
      file_encoding TEXT NOT NULL DEFAULT 'raw',
      original_size INTEGER,
      uploaded_at INTEGER NOT NULL,
      last_read_at INTEGER,
      last_read_position INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_books_uploaded ON books(uploaded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_books_last_read ON books(last_read_at DESC);
    CREATE INDEX IF NOT EXISTS idx_books_title ON books(title);
    CREATE INDEX IF NOT EXISTS idx_books_author ON books(author);
    CREATE INDEX IF NOT EXISTS idx_books_favorite ON books(is_favorite);

    CREATE TABLE IF NOT EXISTS shelves (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT DEFAULT '#bb86fc',
      position INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_shelves_position ON shelves(position);

    CREATE TABLE IF NOT EXISTS shelf_items (
      shelf_id TEXT NOT NULL,
      book_id TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      PRIMARY KEY (shelf_id, book_id),
      FOREIGN KEY (shelf_id) REFERENCES shelves(id) ON DELETE CASCADE,
      FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_shelf_items_book ON shelf_items(book_id);

    CREATE TABLE IF NOT EXISTS progress (
      book_id TEXT PRIMARY KEY,
      percent INTEGER NOT NULL DEFAULT 0,
      current_page INTEGER,
      current_chapter TEXT,
      last_read_at INTEGER NOT NULL,
      FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_progress_last_read ON progress(last_read_at DESC);

    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      reader_theme TEXT DEFAULT 'obsidian',
      reader_font_size INTEGER DEFAULT 16,
      sidebar_collapsed INTEGER DEFAULT 0,
      performance_mode INTEGER DEFAULT 0,
      two_factor_enabled INTEGER DEFAULT 0,
      two_factor_hash TEXT,
      updated_at INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO settings (id, updated_at) VALUES (1, strftime('%s', 'now') * 1000);

    CREATE TABLE IF NOT EXISTS book_content_index (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id TEXT NOT NULL,
      chapter TEXT,
      content_text TEXT,
      snippet TEXT,
      position INTEGER,
      created_at INTEGER,
      FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_content_book ON book_content_index(book_id, position);

    CREATE TABLE IF NOT EXISTS reading_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id TEXT NOT NULL,
      session_start INTEGER,
      session_end INTEGER,
      pages_read INTEGER DEFAULT 0,
      FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_reading_stats_book ON reading_stats(book_id);

    CREATE TABLE IF NOT EXISTS login_attempts (
      ip TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0,
      window_start INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
    );

    CREATE INDEX IF NOT EXISTS idx_books_uploaded ON books(uploaded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_books_last_read ON books(last_read_at DESC);
    CREATE INDEX IF NOT EXISTS idx_books_title ON books(title);
    CREATE INDEX IF NOT EXISTS idx_books_author ON books(author);
    CREATE INDEX IF NOT EXISTS idx_books_favorite ON books(is_favorite);
    CREATE INDEX IF NOT EXISTS idx_shelves_position ON shelves(position);
    CREATE INDEX IF NOT EXISTS idx_shelf_items_book ON shelf_items(book_id);
    CREATE INDEX IF NOT EXISTS idx_progress_last_read ON progress(last_read_at DESC);
    CREATE INDEX IF NOT EXISTS idx_content_book ON book_content_index(book_id, position);
    CREATE INDEX IF NOT EXISTS idx_reading_stats_book ON reading_stats(book_id);
  `);

  // ---- Column backfill for databases created before these columns existed.
  // Must run BEFORE any index that references the new columns. ----
  // ---- Column backfill for databases created before these columns existed.
  // Must run BEFORE any index that references the new columns. ----
  const cols = await db.execute("PRAGMA table_info(books)");
  const names = cols.rows.map((r) => (r as unknown as { name: string }).name);
  if (!names.includes("media_type")) {
    await db.execute("ALTER TABLE books ADD COLUMN media_type TEXT NOT NULL DEFAULT 'book'");
  }
  if (!names.includes("file_encoding")) {
    await db.execute("ALTER TABLE books ADD COLUMN file_encoding TEXT NOT NULL DEFAULT 'raw'");
  }
  if (!names.includes("original_size")) {
    await db.execute("ALTER TABLE books ADD COLUMN original_size INTEGER");
  }
  await db.execute("CREATE INDEX IF NOT EXISTS idx_books_media_type ON books(media_type)");
}
