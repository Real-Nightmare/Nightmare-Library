import { ensureMigrated, getDbAsync } from "./db";
import { isSupabaseConfigured, getSupabase } from "./supabase";

/**
 * Data access layer for the books/shelves domain.
 *
 * Two drivers, chosen automatically:
 * - Supabase Postgres (production) when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set
 *   Free tier, no credit card. Schema mirrors the libSQL/SQLite one.
 * - libSQL local file (development / self-host) otherwise.
 *
 * All functions return plain JSON-serializable objects so callers don't care
 * which driver is active.
 */

/** SQLite driver handle honoring runtime provider selection (local/turso). */
async function sql() {
  await ensureMigrated();
  return getDbAsync();
}

export interface BookRow {
  id: string;
  title: string;
  author: string | null;
  tags: string | null;
  cover_url: string | null;
  file_type: string;
  media_type: string;
  file_size: number | null;
  total_pages: number | null;
  is_favorite: number;
  uploaded_at: number;
  last_read_at: number | null;
  progress: number;
}

export interface NewBook {
  id: string;
  title: string;
  author: string | null;
  tags: string | null;
  storage_provider: string;
  storage_id: string;
  file_type: string;
  /** Bytes actually stored (compressed size when gzip-encoded). */
  file_size: number;
  /** Pre-compression size when the file is stored gzip-encoded. */
  original_size?: number | null;
  /** "gzip" when the stored object is gzipped, "raw" otherwise. */
  file_encoding?: "gzip" | "raw";
  media_type?: string;
  uploaded_at: number;
}

function normalizeBook(row: Record<string, unknown>): BookRow {
  // Postgres returns booleans for is_favorite; SQLite returns 0/1.
  return {
    ...(row as unknown as BookRow),
    is_favorite:
      row.is_favorite === true || row.is_favorite === 1 ? 1 : 0,
    media_type:
      typeof row.media_type === "string" && row.media_type ? row.media_type : "book",
    progress: Number(row.progress ?? 0),
  };
}

// ======================= Books =======================

export async function listBooks(): Promise<BookRow[]> {
  if (await isSupabaseConfigured()) {
    const sb = await getSupabase();
    const { data, error } = await sb
      .from("books")
      .select(
        "id, title, author, tags, cover_url, file_type, media_type, file_size, total_pages, is_favorite, uploaded_at, last_read_at, progress(percent)"
      )
      .order("last_read_at", { ascending: false, nullsFirst: false })
      .order("uploaded_at", { ascending: false });
    if (error) throw new Error(error.message);
    return (data || []).map((r: Record<string, unknown>) => {
      const { progress, ...rest } = r as { progress?: { percent: number }[] | null };
      return normalizeBook({ ...rest, progress: progress?.[0]?.percent ?? 0 });
    });
  }

  await ensureMigrated();
  const result = await (await sql()).execute(`
    SELECT b.id, b.title, b.author, b.tags, b.cover_url, b.file_type, b.media_type, b.file_size,
           b.total_pages, b.is_favorite, b.uploaded_at, b.last_read_at,
           COALESCE(p.percent, 0) as progress
    FROM books b
    LEFT JOIN progress p ON b.id = p.book_id
    ORDER BY b.last_read_at DESC NULLS LAST, b.uploaded_at DESC
  `);
  return result.rows.map((r) => normalizeBook(r as Record<string, unknown>));
}

export async function getBook(id: string): Promise<BookRow | null> {
  if (await isSupabaseConfigured()) {
    const sb = await getSupabase();
    const { data, error } = await sb
      .from("books")
      .select(
        "id, title, author, tags, cover_url, file_type, media_type, file_size, total_pages, is_favorite, uploaded_at, last_read_at, progress(percent)"
      )
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    const { progress, ...rest } = data as { progress?: { percent: number }[] | null };
    return normalizeBook({ ...rest, progress: progress?.[0]?.percent ?? 0 });
  }

  await ensureMigrated();
  const result = await (await sql()).execute({
    sql: `SELECT b.id, b.title, b.author, b.tags, b.cover_url, b.file_type, b.media_type, b.file_size,
                 b.total_pages, b.is_favorite, b.uploaded_at, b.last_read_at,
                 COALESCE(p.percent, 0) as progress
          FROM books b
          LEFT JOIN progress p ON b.id = p.book_id
          WHERE b.id = ?`,
    args: [id],
  });
  return result.rows[0] ? normalizeBook(result.rows[0] as Record<string, unknown>) : null;
}

export async function insertBook(book: NewBook): Promise<void> {
  if (await isSupabaseConfigured()) {
    const sb = await getSupabase();
    const { error } = await sb.from("books").insert({
      id: book.id,
      title: book.title,
      author: book.author,
      tags: book.tags,
      storage_provider: book.storage_provider,
      storage_id: book.storage_id,
      file_type: book.file_type,
      file_size: book.file_size,
      original_size: book.original_size ?? null,
      file_encoding: book.file_encoding || "raw",
      media_type: book.media_type || "book",
      uploaded_at: book.uploaded_at,
    });
    if (error) throw new Error(error.message);
    return;
  }

  await (await sql()).execute({
    sql: `INSERT INTO books (id, title, author, storage_provider, storage_id, file_type, file_size, original_size, file_encoding, tags, media_type, uploaded_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      book.id,
      book.title,
      book.author,
      book.storage_provider,
      book.storage_id,
      book.file_type,
      book.file_size,
      book.original_size ?? null,
      book.file_encoding || "raw",
      book.tags,
      book.media_type || "book",
      book.uploaded_at,
    ],
  });
}

export async function deleteBookRow(id: string): Promise<void> {
  if (await isSupabaseConfigured()) {
    const sb = await getSupabase();
    // progress + shelf_items + content index cascade via FKs
    const { error } = await sb.from("books").delete().eq("id", id);
    if (error) throw new Error(error.message);
    return;
  }

  await ensureMigrated();
  await (await sql()).execute({ sql: "DELETE FROM books WHERE id = ?", args: [id] });
}

export async function updateBook(
  id: string,
  fields: { title?: string; author?: string; tags?: string; is_favorite?: boolean; media_type?: string }
): Promise<void> {
  if (Object.keys(fields).length === 0) return;

  if (await isSupabaseConfigured()) {
    const sb = await getSupabase();
    const { error } = await sb.from("books").update(fields).eq("id", id);
    if (error) throw new Error(error.message);
    return;
  }

  await ensureMigrated();
  const sets: string[] = [];
  const args: (string | number)[] = [];
  if (fields.title !== undefined) { sets.push("title = ?"); args.push(fields.title); }
  if (fields.author !== undefined) { sets.push("author = ?"); args.push(fields.author); }
  if (fields.tags !== undefined) { sets.push("tags = ?"); args.push(fields.tags); }
  if (fields.is_favorite !== undefined) { sets.push("is_favorite = ?"); args.push(fields.is_favorite ? 1 : 0); }
  if (fields.media_type !== undefined) { sets.push("media_type = ?"); args.push(fields.media_type); }
  args.push(id);
  await (await sql()).execute({ sql: `UPDATE books SET ${sets.join(", ")} WHERE id = ?`, args });
}

export async function getBookStorage(id: string): Promise<{
  storage_provider: string;
  storage_id: string;
  file_type: string;
  file_encoding: string | null;
  original_size: number | null;
  title: string;
} | null> {
  if (await isSupabaseConfigured()) {
    const sb = await getSupabase();
    const { data, error } = await sb
      .from("books")
      .select("storage_provider, storage_id, file_type, file_encoding, original_size, title")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return (data as never) || null;
  }

  const result = await (await sql()).execute({
    sql: "SELECT storage_provider, storage_id, file_type, file_encoding, original_size, title FROM books WHERE id = ?",
    args: [id],
  });
  return (result.rows[0] as never) || null;
}

export async function markBookRead(id: string, at: number): Promise<void> {
  if (await isSupabaseConfigured()) {
    const sb = await getSupabase();
    const { error } = await sb.from("books").update({ last_read_at: at }).eq("id", id);
    if (error) throw new Error(error.message);
    return;
  }
  await ensureMigrated();
  await (await sql()).execute({
    sql: "UPDATE books SET last_read_at = ? WHERE id = ?",
    args: [at, id],
  });
}

// ======================= Progress =======================

export async function saveProgress(
  bookId: string,
  percent: number,
  page: number | null,
  chapter: string | null,
  at: number
): Promise<void> {
  if (await isSupabaseConfigured()) {
    const sb = await getSupabase();
    const { error } = await sb.from("progress").upsert(
      {
        book_id: bookId,
        percent,
        current_page: page,
        current_chapter: chapter,
        last_read_at: at,
      },
      { onConflict: "book_id" }
    );
    if (error) throw new Error(error.message);
    return;
  }

  await ensureMigrated();
  await (await sql()).execute({
    sql: `INSERT INTO progress (book_id, percent, current_page, current_chapter, last_read_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(book_id) DO UPDATE SET
            percent = excluded.percent,
            current_page = excluded.current_page,
            current_chapter = excluded.current_chapter,
            last_read_at = excluded.last_read_at`,
    args: [bookId, percent, page, chapter, at],
  });
}

export async function getProgress(bookId: string): Promise<{
  percent: number;
  current_page: number | null;
  current_chapter: string | null;
  last_read_at: number | null;
}> {
  if (await isSupabaseConfigured()) {
    const sb = await getSupabase();
    const { data } = await sb
      .from("progress")
      .select("percent, current_page, current_chapter, last_read_at")
      .eq("book_id", bookId)
      .maybeSingle();
    return (
      (data as never) || { percent: 0, current_page: 1, current_chapter: null, last_read_at: null }
    );
  }

  await ensureMigrated();
  const result = await (await sql()).execute({
    sql: "SELECT percent, current_page, current_chapter, last_read_at FROM progress WHERE book_id = ?",
    args: [bookId],
  });
  return (result.rows[0] as never) || { percent: 0, current_page: 1, current_chapter: null, last_read_at: null };
}

// ======================= Shelves =======================

export async function listShelves(): Promise<
  { id: string; name: string; color: string; position: number; book_count: number }[]
> {
  if (await isSupabaseConfigured()) {
    const sb = await getSupabase();
    const { data, error } = await sb
      .from("shelves")
      .select("id, name, color, position, shelf_items(count)")
      .order("position")
      .order("created_at");
    if (error) throw new Error(error.message);
    return (data || []).map((s: Record<string, unknown>) => {
      const items = s.shelf_items as { count: number }[] | null;
      return {
        id: s.id as string,
        name: s.name as string,
        color: (s.color as string) || "#bb86fc",
        position: Number(s.position ?? 0),
        book_count: items?.[0]?.count ?? 0,
      };
    });
  }

  await ensureMigrated();
  const result = await (await sql()).execute(`
    SELECT s.id, s.name, s.color, s.position, COUNT(si.book_id) as book_count
    FROM shelves s
    LEFT JOIN shelf_items si ON s.id = si.shelf_id
    GROUP BY s.id
    ORDER BY s.position, s.created_at
  `);
  return result.rows.map((r) => r as never);
}

export async function createShelf(
  name: string,
  color: string,
  position: number
): Promise<{ id: string; name: string; color: string; position: number }> {
  const id = `shelf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  if (await isSupabaseConfigured()) {
    const sb = await getSupabase();
    const { error } = await sb
      .from("shelves")
      .insert({ id, name, color, position, created_at: Date.now() });
    if (error) throw new Error(error.message);
    return { id, name, color, position };
  }

  await ensureMigrated();
  await (await sql()).execute({
    sql: "INSERT INTO shelves (id, name, color, position, created_at) VALUES (?, ?, ?, ?, ?)",
    args: [id, name, color, position, Date.now()],
  });
  return { id, name, color, position };
}

export async function nextShelfPosition(): Promise<number> {
  if (await isSupabaseConfigured()) {
    const sb = await getSupabase();
    const { count } = await sb.from("shelves").select("*", { count: "exact", head: true });
    return count ?? 0;
  }
  await ensureMigrated();
  const r = await (await sql()).execute("SELECT COALESCE(MAX(position), -1) + 1 as pos FROM shelves");
  return Number(r.rows[0].pos);
}

export async function addBookToShelf(shelfId: string, bookId: string): Promise<void> {
  if (await isSupabaseConfigured()) {
    const sb = await getSupabase();
    const { error } = await sb
      .from("shelf_items")
      .upsert({ shelf_id: shelfId, book_id: bookId, added_at: Date.now() }, { onConflict: "shelf_id,book_id" });
    if (error) throw new Error(error.message);
    return;
  }
  await ensureMigrated();
  await (await sql()).execute({
    sql: "INSERT OR IGNORE INTO shelf_items (shelf_id, book_id, added_at) VALUES (?, ?, ?)",
    args: [shelfId, bookId, Date.now()],
  });
}

export async function removeBookFromShelf(shelfId: string, bookId: string): Promise<void> {
  if (await isSupabaseConfigured()) {
    const sb = await getSupabase();
    const { error } = await sb.from("shelf_items").delete().match({ shelf_id: shelfId, book_id: bookId });
    if (error) throw new Error(error.message);
    return;
  }
  await ensureMigrated();
  await (await sql()).execute({
    sql: "DELETE FROM shelf_items WHERE shelf_id = ? AND book_id = ?",
    args: [shelfId, bookId],
  });
}

export async function listShelfBooks(
  shelfId: string
): Promise<{ id: string; title: string; author: string | null; file_type: string; cover_url: string | null; progress: number }[]> {
  if (await isSupabaseConfigured()) {
    const sb = await getSupabase();
    const { data, error } = await sb
      .from("shelf_items")
      .select("book_id, books(id, title, author, file_type, cover_url, progress(percent))")
      .eq("shelf_id", shelfId)
      .order("added_at", { ascending: false });
    if (error) throw new Error(error.message);
    return (data || []).map((row: Record<string, unknown>) => {
      const b = row.books as Record<string, unknown> | null;
      if (!b) return null;
      const prog = b.progress as { percent: number }[] | null;
      return {
        id: b.id as string,
        title: b.title as string,
        author: (b.author as string) || null,
        file_type: b.file_type as string,
        cover_url: (b.cover_url as string) || null,
        progress: prog?.[0]?.percent ?? 0,
      };
    }).filter(Boolean) as never;
  }

  await ensureMigrated();
  const result = await (await sql()).execute({
    sql: `SELECT b.id, b.title, b.author, b.file_type, b.cover_url,
                 COALESCE(p.percent, 0) as progress
          FROM shelf_items si
          JOIN books b ON si.book_id = b.id
          LEFT JOIN progress p ON b.id = p.book_id
          WHERE si.shelf_id = ?
          ORDER BY si.added_at DESC`,
    args: [shelfId],
  });
  return result.rows.map((r) => r as never);
}

// ======================= Stats =======================

export async function getStats(): Promise<{
  totalBooks: number;
  totalPages: number;
  favorites: number;
  inProgress: number;
  storageUsedBytes: number;
  recent: { id: string; title: string; author: string | null; file_type: string }[];
}> {
  if (await isSupabaseConfigured()) {
    const sb = await getSupabase();
    const [countRes, pagesRes, favRes, progRes, sizeRes, recentRes] = await Promise.all([
      sb.from("books").select("*", { count: "exact", head: true }),
      sb.from("books").select("total_pages"),
      sb.from("books").select("*", { count: "exact", head: true }).eq("is_favorite", true),
      sb.from("progress").select("*", { count: "exact", head: true }).gt("percent", 0),
      sb.from("books").select("file_size"),
      sb.from("books").select("id, title, author, file_type").order("last_read_at", { ascending: false, nullsFirst: false }).limit(5),
    ]);
    const sum = (rows: Record<string, unknown>[] | null, key: string) =>
      (rows || []).reduce((acc, r) => acc + Number(r[key] ?? 0), 0);
    return {
      totalBooks: countRes.count ?? 0,
      totalPages: sum(pagesRes.data, "total_pages"),
      favorites: favRes.count ?? 0,
      inProgress: progRes.count ?? 0,
      storageUsedBytes: sum(sizeRes.data, "file_size"),
      recent: (recentRes.data as never) || [],
    };
  }

  await ensureMigrated();
  const db = (await sql());
  const [books, pages, favs, prog, size, recent] = await Promise.all([
    db.execute("SELECT COUNT(*) as c FROM books"),
    db.execute("SELECT COALESCE(SUM(total_pages), 0) as c FROM books"),
    db.execute("SELECT COUNT(*) as c FROM books WHERE is_favorite = 1"),
    db.execute("SELECT COUNT(*) as c FROM progress WHERE percent > 0"),
    db.execute("SELECT COALESCE(SUM(file_size), 0) as c FROM books"),
    db.execute("SELECT id, title, author, file_type FROM books ORDER BY last_read_at DESC NULLS LAST LIMIT 5"),
  ]);
  return {
    totalBooks: Number(books.rows[0].c),
    totalPages: Number(pages.rows[0].c),
    favorites: Number(favs.rows[0].c),
    inProgress: Number(prog.rows[0].c),
    storageUsedBytes: Number(size.rows[0].c),
    recent: recent.rows.map((r) => r as never),
  };
}

export async function getLoginAttempts(ip: string): Promise<{ count: number; window_start: number } | null> {
  if (await isSupabaseConfigured()) {
    const sb = await getSupabase();
    const { data } = await sb
      .from("login_attempts")
      .select("count, window_start")
      .eq("ip", ip)
      .maybeSingle();
    return (data as never) || null;
  }
  await ensureMigrated();
  const r = await (await sql()).execute({
    sql: "SELECT count, window_start FROM login_attempts WHERE ip = ?",
    args: [ip],
  });
  return (r.rows[0] as never) || null;
}

export async function upsertLoginAttempts(ip: string, count: number, windowStart: number): Promise<void> {
  if (await isSupabaseConfigured()) {
    const sb = await getSupabase();
    const { error } = await sb
      .from("login_attempts")
      .upsert({ ip, count, window_start: windowStart }, { onConflict: "ip" });
    if (error) throw new Error(error.message);
    return;
  }
  await ensureMigrated();
  await (await sql()).execute({
    sql: `INSERT INTO login_attempts (ip, count, window_start) VALUES (?, ?, ?)
          ON CONFLICT(ip) DO UPDATE SET count = excluded.count, window_start = excluded.window_start`,
    args: [ip, count, windowStart],
  });
}

export async function clearLoginAttempts(ip: string): Promise<void> {
  if (await isSupabaseConfigured()) {
    const sb = await getSupabase();
    await sb.from("login_attempts").delete().eq("ip", ip);
    return;
  }
  await ensureMigrated();
  await (await sql()).execute({ sql: "DELETE FROM login_attempts WHERE ip = ?", args: [ip] });
}

// ======================= Content search =======================

export async function searchBookContent(
  bookId: string,
  q: string
): Promise<{ chapter: string | null; snippet: string | null; position: number | null }[]> {
  if (await isSupabaseConfigured()) {
    const sb = await getSupabase();
    const { data, error } = await sb
      .from("book_content_index")
      .select("chapter, snippet, position")
      .eq("book_id", bookId)
      .or(`content_text.ilike.%${q}%,snippet.ilike.%${q}%`)
      .order("position")
      .limit(50);
    if (error) throw new Error(error.message);
    return (data as never) || [];
  }
  await ensureMigrated();
  const result = await (await sql()).execute({
    sql: `SELECT chapter, snippet, position FROM book_content_index
          WHERE book_id = ? AND (content_text LIKE ? OR snippet LIKE ?)
          ORDER BY position LIMIT 50`,
    args: [bookId, `%${q}%`, `%${q}%`],
  });
  return result.rows.map((r) => r as never);
}
