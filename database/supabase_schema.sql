-- ============================================
-- Nightmare Library — Supabase (Postgres) schema
-- Run once: Supabase Dashboard → SQL Editor → paste → Run
-- Mirrors the libSQL/SQLite schema used in development.
-- ============================================

CREATE TABLE IF NOT EXISTS books (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    author TEXT,
    storage_provider TEXT NOT NULL,
    storage_id TEXT NOT NULL,
    cover_url TEXT,
    file_type TEXT NOT NULL,
    file_size BIGINT,
    tags TEXT,
    total_pages INTEGER,
    is_favorite BOOLEAN NOT NULL DEFAULT FALSE,
    custom_order INTEGER DEFAULT 0,
    uploaded_at BIGINT NOT NULL,
    last_read_at BIGINT,
    last_read_position INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_books_uploaded ON books(uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_books_last_read ON books(last_read_at DESC);
CREATE INDEX IF NOT EXISTS idx_books_title ON books(title);
CREATE INDEX IF NOT EXISTS idx_books_author ON books(author);
CREATE INDEX IF NOT EXISTS idx_books_favorite ON books(is_favorite);

-- ============================================
-- SHELVES
-- ============================================

CREATE TABLE IF NOT EXISTS shelves (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT DEFAULT '#bb86fc',
    position INTEGER DEFAULT 0,
    created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shelves_position ON shelves(position);

-- ============================================
-- SHELF ITEMS (many-to-many)
-- ============================================

CREATE TABLE IF NOT EXISTS shelf_items (
    shelf_id TEXT NOT NULL REFERENCES shelves(id) ON DELETE CASCADE,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    added_at BIGINT NOT NULL,
    PRIMARY KEY (shelf_id, book_id)
);

CREATE INDEX IF NOT EXISTS idx_shelf_items_book ON shelf_items(book_id);

-- ============================================
-- READING PROGRESS
-- ============================================

CREATE TABLE IF NOT EXISTS progress (
    book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
    percent INTEGER NOT NULL DEFAULT 0,
    current_page INTEGER,
    current_chapter TEXT,
    last_read_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_progress_last_read ON progress(last_read_at DESC);

-- ============================================
-- READER SETTINGS (single-user app)
-- ============================================

CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    reader_theme TEXT DEFAULT 'obsidian',
    reader_font_size INTEGER DEFAULT 16,
    sidebar_collapsed BOOLEAN DEFAULT FALSE,
    performance_mode BOOLEAN DEFAULT FALSE,
    updated_at BIGINT NOT NULL
);

-- ============================================
-- FULL-TEXT CONTENT INDEX
-- ============================================

CREATE TABLE IF NOT EXISTS book_content_index (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    chapter TEXT,
    content_text TEXT,
    snippet TEXT,
    position INTEGER,
    created_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_content_book ON book_content_index(book_id, position);

-- ============================================
-- LOGIN RATE LIMITING
-- ============================================

CREATE TABLE IF NOT EXISTS login_attempts (
    ip TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0,
    window_start BIGINT NOT NULL
);

-- ============================================
-- READING STATISTICS
-- ============================================

CREATE TABLE IF NOT EXISTS reading_stats (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    session_start BIGINT,
    session_end BIGINT,
    pages_read INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_reading_stats_book ON reading_stats(book_id);

-- ============================================
-- MEDIA TYPES (library sections)
-- Run this migration if your tables already exist:
-- books.media_type: 'book' | 'ln' | 'manga' | 'anime_official'
-- ============================================

ALTER TABLE books ADD COLUMN IF NOT EXISTS media_type TEXT NOT NULL DEFAULT 'book';
CREATE INDEX IF NOT EXISTS idx_books_media_type ON books(media_type);
