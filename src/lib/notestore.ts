import { mkdirSync } from "fs";
import path from "path";
import { createClient, type Client } from "@libsql/client";

/**
 * Highlights, notes and bookmarks — the Kindle / Google Play Books layer.
 *
 * STORAGE: the existing `app_settings` key/value table, under `notes:<bookId>`
 * keys. That is deliberate. It is already in both the Supabase and SQLite
 * schemas, it is already reached through the env-detected driver, and it
 * means shipping reading notes needs NO database migration — which matters
 * because schema changes on the hosted Postgres require someone to run SQL by
 * hand. The notes therefore sync across devices exactly like everything else
 * in the library.
 *
 * `appsettings.setSettings` filters to a fixed allow-list of settings keys, so
 * this writes through its own driver rather than going through that helper.
 */

export interface Note {
  id: string;
  /** "highlight" (selected text) or "bookmark" (a place, not a passage). */
  kind: "highlight" | "bookmark";
  /** The selected passage, for highlights. */
  text: string;
  /** Optional reader-written note, for both kinds. */
  note: string;
  /** EPUB CFI or chapter href the note points at. */
  anchor: string;
  chapter: string;
  percent: number;
  created: number;
  color: string;
}

const PREFIX = "notes:";

let kvClient: Client | null = null;

function getKvClient(): Client {
  if (kvClient) return kvClient;
  const url = process.env.TURSO_DATABASE_URL?.trim();
  if (url) {
    kvClient = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN?.trim() || undefined });
  } else {
    mkdirSync(path.join(process.cwd(), ".data"), { recursive: true });
    kvClient = createClient({ url: "file:.data/nightmare.db" });
  }
  return kvClient;
}

function useSupabase(): boolean {
  return Boolean(process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_SERVICE_ROLE_KEY?.trim());
}

async function ensureTable(): Promise<void> {
  if (useSupabase()) return; // schema.sql already creates app_settings
  await getKvClient().execute(`CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
  )`);
}

async function readRaw(key: string): Promise<string | null> {
  try {
    await ensureTable();
    if (useSupabase()) {
      const { getSupabase } = await import("./supabase");
      const sb = await getSupabase();
      const { data, error } = await sb.from("app_settings").select("value").eq("key", key).maybeSingle();
      if (error) throw new Error(error.message);
      return (data?.value as string | null) ?? null;
    }
    const res = await getKvClient().execute({ sql: "SELECT value FROM app_settings WHERE key = ?", args: [key] });
    const row = res.rows[0] as unknown as { value: string | null } | undefined;
    return row?.value ?? null;
  } catch (error) {
    console.error("notestore read failed:", error);
    return null;
  }
}

async function writeRaw(key: string, value: string | null): Promise<void> {
  try {
    await ensureTable();
    if (useSupabase()) {
      const { getSupabase } = await import("./supabase");
      const sb = await getSupabase();
      const { error } = await sb
        .from("app_settings")
        .upsert({ key, value }, { onConflict: "key" });
      if (error) throw new Error(error.message);
      return;
    }
    const db = getKvClient();
    await db.execute({
      sql: `INSERT INTO app_settings (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%s', 'now') * 1000`,
      args: [key, value],
    });
  } catch (error) {
    console.error("notestore write failed:", error);
  }
}

function parseNotes(raw: string | null): Note[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((n) => n && typeof n.id === "string");
  } catch {
    return [];
  }
}

/** All highlights and bookmarks for one book, newest first. */
export async function listNotes(bookId: string): Promise<Note[]> {
  const notes = parseNotes(await readRaw(PREFIX + bookId));
  return notes.sort((a, b) => (b.created || 0) - (a.created || 0));
}

/** Add a highlight or bookmark. Returns the stored note. */
export async function addNote(bookId: string, input: Partial<Note>): Promise<Note> {
  const note: Note = {
    id: input.id || `note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: input.kind === "bookmark" ? "bookmark" : "highlight",
    text: (input.text || "").slice(0, 4000),
    note: (input.note || "").slice(0, 2000),
    anchor: (input.anchor || "").slice(0, 500),
    chapter: (input.chapter || "").slice(0, 200),
    percent: Math.max(0, Math.min(100, Math.round(Number(input.percent) || 0))),
    created: input.created || Date.now(),
    color: input.color || "amber",
  };
  const existing = parseNotes(await readRaw(PREFIX + bookId));
  const next = [note, ...existing].slice(0, 500);
  await writeRaw(PREFIX + bookId, JSON.stringify(next));
  return note;
}

/** Update just the note text of an existing highlight. */
export async function updateNote(bookId: string, id: string, patch: { note?: string; color?: string }): Promise<Note | null> {
  const existing = parseNotes(await readRaw(PREFIX + bookId));
  const idx = existing.findIndex((n) => n.id === id);
  if (idx === -1) return null;
  const updated: Note = {
    ...existing[idx],
    note: patch.note !== undefined ? patch.note.slice(0, 2000) : existing[idx].note,
    color: patch.color || existing[idx].color,
  };
  existing[idx] = updated;
  await writeRaw(PREFIX + bookId, JSON.stringify(existing));
  return updated;
}

/** Remove one note. */
export async function deleteNote(bookId: string, id: string): Promise<boolean> {
  const existing = parseNotes(await readRaw(PREFIX + bookId));
  const next = existing.filter((n) => n.id !== id);
  if (next.length === existing.length) return false;
  await writeRaw(PREFIX + bookId, JSON.stringify(next));
  return true;
}

/** Every book that has at least one highlight — powers the notebook index. */
export async function listAnnotatedBooks(): Promise<Record<string, number>> {
  try {
    await ensureTable();
    const out: Record<string, number> = {};
    if (useSupabase()) {
      const { getSupabase } = await import("./supabase");
      const sb = await getSupabase();
      const { data, error } = await sb.from("app_settings").select("key, value").like("key", `${PREFIX}%`);
      if (error) throw new Error(error.message);
      for (const row of (data || []) as { key: string; value: string | null }[]) {
        out[row.key.slice(PREFIX.length)] = parseNotes(row.value).length;
      }
      return out;
    }
    const res = await getKvClient().execute({
      sql: "SELECT key, value FROM app_settings WHERE key LIKE ?",
      args: [`${PREFIX}%`],
    });
    for (const row of res.rows as unknown as { key: string; value: string | null }[]) {
      out[row.key.slice(PREFIX.length)] = parseNotes(row.value).length;
    }
    return out;
  } catch (error) {
    console.error("notestore index failed:", error);
    return {};
  }
}
