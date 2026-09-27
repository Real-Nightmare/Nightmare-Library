import { createClient, type Client } from "@libsql/client";
import { mkdirSync } from "fs";
import path from "path";

/**
 * Database layer for Nightmare Library.
 *
 * Replaces the old 10-shard Cloudflare D1 setup with a single SQLite database
 * (libSQL). The original schema is preserved 1:1 — tables, columns and indexes
 * are identical to `database/schema.sql`.
 *
 * - Local dev: uses a file at `.data/nightmare.db` (no external service needed)
 * - Production: set `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` to use Turso
 *   (free tier: 5GB, no credit card — https://turso.tech)
 */

let client: Client | null = null;

export function getDb(): Client {
  if (client) return client;

  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (url) {
    client = createClient({ url, authToken });
  } else {
    // Local file database — perfect for development and small self-hosted deploys.
    // libSQL does not create parent directories, so ensure .data exists first.
    mkdirSync(path.join(process.cwd(), ".data"), { recursive: true });
    client = createClient({ url: "file:.data/nightmare.db" });
  }

  return client;
}

/** Runs once per cold start; creates all tables if missing. */
let migrated = false;
export async function ensureMigrated(): Promise<void> {
  if (migrated) return;
  const db = getDb();

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
      uploaded_at INTEGER NOT NULL,
      last_read_at INTEGER,
      last_read_position INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_books_uploaded ON books(uploaded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_books_last_read ON books(last_read_at DESC);
    CREATE INDEX IF NOT EXISTS idx_books_title ON books(title);
    CREATE INDEX IF NOT EXISTS idx_books_author ON books(author);
    CREATE INDEX IF NOT EXISTS idx_books_favorite ON books(is_favorite);
    CREATE INDEX IF NOT EXISTS idx_books_media_type ON books(media_type);

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
  `);

  // Older local databases may predate the media_type column — add it if missing.
  const cols = await db.execute("PRAGMA table_info(books)");
  if (!cols.rows.some((r) => (r as unknown as { name: string }).name === "media_type")) {
    await db.execute("ALTER TABLE books ADD COLUMN media_type TEXT NOT NULL DEFAULT 'book'");
  }

  migrated = true;
}
