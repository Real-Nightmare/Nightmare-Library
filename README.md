# Nightmare Library

A private, password-protected digital library for reading **EPUB** and **PDF** books and watching **anime** (official MP4/WebM uploads) — full-stack **Next.js**, deployable on **Freebuff hosting**.

Obsidian-black theme, reading progress tracking, shelves/collections, favorites, in-book search, reading stats, **runtime provider switching** and **transparent client-side compression**.

## Library sections

Every item belongs to one of four sections (retag any item with the ⇄ button on its card):

| Section | Contents |
|---|---|
| Books | Regular PDFs |
| Light Novel (LN) | EPUB novels |
| Manga | EPUB manga |
| Anime (Official) | MP4/WebM video uploads, streamed with HTTP Range (seeking works) |

Schema migration for existing Supabase projects: re-run `database/supabase_schema.sql` in the SQL editor (it is idempotent — adds `books.media_type`).

## What changed from the Cloudflare version

| Before (Cloudflare) | Now (Freebuff / Next.js) |
|---|---|
| 10 sharded D1 databases + broken `env.DB` bug | Single SQLite database via **libSQL** — same schema, one source of truth |
| 10-provider storage cascade (Mega stub, OAuth token churn) | Local disk storage by default, **Uploadthing** (2GB free, no card) optional in production |
| Two duplicate auth implementations with different rate limits | One auth API: signed HMAC session cookie, IP rate limiting (10 tries / 15 min) |
| Vanilla JS + no real EPUB support (iframe to a blob) | Real EPUB rendering with **epub.js**, page/percentage progress, in-book search |
| Docs referencing files that didn't exist | Everything in this README is real |

## Environment variables

Set in **Freebuff → Settings → Environment** (or a local `.env.local` for dev):

| Variable | Required | Purpose |
|---|---|---|
| `PASSWORD` | Yes | Library login password |
| `JWT_SECRET` | Recommended | Session token signing secret (falls back to `PASSWORD` if unset) |
| `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` | Optional | Use Turso (free 5GB, no card) instead of local SQLite file |
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | Optional | Use Supabase Postgres (free, no card) as the database — recommended for serverless production. Run `database/supabase_schema.sql` in the Supabase SQL editor once |
| `B2_KEY_ID` + `B2_APPLICATION_KEY` + `B2_BUCKET_NAME` | Optional | Backblaze B2 book storage — 10GB free, no card, S3-compatible |
| `B2_REGION` | Optional | B2 region (default `us-east-005`) |
| `B2_CASCADE_*` | Optional | Second S3-compatible provider (endpoint, key id, secret, bucket) used when B2 fails — for scaling past 10GB |
| `UPLOADTHING_SECRET` + `UPLOADTHING_APP_ID` | Optional | Uploadthing (2GB free) — currently server-side only as local fallback |

With nothing but `PASSWORD` set, the app runs fully self-contained (local SQLite + local disk).

## Settings page (runtime configuration)

The **⚙️ Settings** page in the dashboard lets the owner, at runtime and without redeploying:

- **Switch database provider** — Supabase Postgres, Turso (remote SQLite), or the local SQLite file. Connectivity is tested before saving.
- **Switch storage provider** — Backblaze B2, B2 with cascade failover (a second S3-compatible provider used automatically when B2 fails), or server disk.
- **Change the site password** — requires the current password; takes effect immediately and signs out all devices. Leave the new password blank to revert to the `PASSWORD` env var.

Secrets are stored as masked values (first 3 chars + bullets) in the API responses and saved as overrides in the `app_settings` table; environment variables remain the fallback wherever no override exists. Resolution order: **settings override → env var → default**.

### Upload compression (automatic)

EPUB and PDF files are gzip-compressed in the browser (`CompressionStream`) before upload when that actually saves space (>3% gain; the server applies the same policy server-side otherwise). Per-file `file_encoding` records what is stored and every read decompresses transparently — the reader and downloads always receive original bytes. Typical savings: 5–15% beyond the EPUB's built-in zip, more on PDFs. Video is stored raw and streams with HTTP Range seeking.

## Running locally

```bash
bun install
bun run dev
```

Then open http://localhost:3000 and log in with your `PASSWORD`.

## Deploying on Freebuff

1. `freebuff-preview set-install "bun install"` (already the default)
2. `freebuff-preview set "bun run dev" 3000`
3. `freebuff-preview set-build "bun run build"`
4. `freebuff-deploy check` → `freebuff-deploy start`

## API surface

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/auth` | Login (rate-limited) |
| DELETE | `/api/auth` | Logout |
| GET | `/api/books` | List all books with progress |
| POST | `/api/books` | Upload EPUB/PDF/MP4 (≤200MB, presigned to B2 when configured) |
| GET | `/api/books/:id` | Book metadata |
| DELETE | `/api/books/:id` | Delete book + file |
| GET | `/api/books/:id/file` | Stream book file to reader |
| GET | `/api/books/:id/media` | Range-capable video streaming |
| GET/POST | `/api/books/:id/progress` | Reading progress |
| PATCH | `/api/books/:id/update` | Title/author/tags/favorite/media_type |
| GET | `/api/books/:id/search?q=` | In-book content search |
| GET/POST | `/api/shelves` | List/create shelves |
| GET/POST/DELETE | `/api/shelves/:id/books` | Manage shelf membership |
| POST | `/api/ai/genre` | Keyword-based genre suggestions |
| GET | `/api/stats` | Library statistics |

## Recommended free tools (no credit card)

| Need | Tool | Free tier |
|---|---|---|
| Database | **Turso** (turso.tech) | 5GB SQLite, 500M row reads/mo |
| Book file storage | **Uploadthing** (uploadthing.com) | 2GB, direct-to-storage uploads |
| Alternative storage | **Vercel Blob** | 1GB on Hobby |
| Alternative DB | **Neon** (neon.tech) | Free Postgres (schema rewrite needed) |
| Alternative full-stack host | **Vercel Hobby** | Free forever, non-commercial, 4.5MB body limit |
