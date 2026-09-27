"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface Book {
  id: string;
  title: string;
  author: string | null;
  tags: string | null;
  cover_url: string | null;
  file_type: string;
  media_type: string;
  file_size: number | null;
  is_favorite: number;
  progress: number;
}

interface Shelf {
  id: string;
  name: string;
  color: string;
  book_count: number;
}

type Filter =
  | "all"
  | "epub"
  | "pdf"
  | "recent"
  | "favorites"
  | "sec:book"
  | "sec:ln"
  | "sec:manga"
  | "sec:anime_official"
  | `shelf:${string}`;

const SECTIONS: { key: Filter; label: string; icon: string }[] = [
  { key: "sec:ln", label: "Light Novel (LN)", icon: "📖" },
  { key: "sec:manga", label: "Manga", icon: "📗" },
  { key: "sec:anime_official", label: "Anime (Official)", icon: "📺" },
];

const MEDIA_LABELS: Record<string, string> = {
  book: "Book",
  ln: "LN",
  manga: "Manga",
  anime_official: "Anime",
};

const MEDIA_CYCLE = ["book", "ln", "manga", "anime_official"];

export default function DashboardPage() {
  const router = useRouter();
  const [books, setBooks] = useState<Book[] | null>(null);
  const [shelves, setShelves] = useState<Shelf[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [uploadMsg, setUploadMsg] = useState("");
  const [uploadMediaType, setUploadMediaType] = useState("book");
  const [newShelfName, setNewShelfName] = useState("");
  const [showShelfInput, setShowShelfInput] = useState(false);

  const loadBooks = useCallback(async () => {
    try {
      const res = await fetch("/api/books");
      if (res.status === 401) {
        router.push("/");
        return;
      }
      const data = await res.json();
      setBooks(data.books || []);
    } catch {
      setBooks([]);
    }
  }, [router]);

  const loadShelves = useCallback(async () => {
    const res = await fetch("/api/shelves");
    if (res.ok) {
      const data = await res.json();
      setShelves(data.shelves || []);
    }
  }, []);

  useEffect(() => {
    loadBooks();
    loadShelves();
  }, [loadBooks, loadShelves]);

  const isVideo = (b: Book) => b.file_type === "mp4" || b.file_type === "webm" || b.file_type === "m4v";
  const openTarget = (b: Book) =>
    b.media_type === "anime_official" || isVideo(b) ? `/watch?id=${b.id}` : `/reader?id=${b.id}`;

  const handleUpload = async (file: File) => {
    setUploading(true);
    setProgress(5);
    setUploadMsg("Preparing upload...");

    const name = file.name.toLowerCase();
    const fileType = name.endsWith(".epub")
      ? "epub"
      : name.endsWith(".pdf")
        ? "pdf"
        : name.endsWith(".mp4")
          ? "mp4"
          : name.endsWith(".webm")
            ? "webm"
            : null;
    if (!fileType) {
      setUploadMsg("Only EPUB, PDF and MP4 files are supported.");
      setUploading(false);
      return;
    }

    try {
      const presignRes = await fetch("/api/books", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileType, mediaType: uploadMediaType }),
      });
      const presignData = await presignRes.json();

      if (presignData.success && presignData.presign) {
        setUploadMsg("Uploading to storage...");
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("PUT", presignData.uploadUrl);
          xhr.setRequestHeader(
            "Content-Type",
            fileType === "epub" ? "application/epub+zip" : fileType === "mp4" ? "video/mp4" : "application/pdf"
          );
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              setProgress(Math.max(5, Math.round((e.loaded / e.total) * 90)));
            }
          };
          xhr.onload = () =>
            xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Storage upload failed (${xhr.status})`));
          xhr.onerror = () => reject(new Error("Storage upload failed"));
          xhr.send(file);
        });

        setProgress(95);
        setUploadMsg("Finalizing...");
        const confirmRes = await fetch("/api/books", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            uploadId: presignData.uploadId,
            title: file.name.replace(/\.[^.]+$/, ""),
            mediaType: uploadMediaType,
          }),
        });
        const confirmData = await confirmRes.json();
        if (!confirmData.success) throw new Error(confirmData.message || "Finalize failed");
      } else {
        setUploadMsg("Uploading...");
        const formData = new FormData();
        formData.append("file", file);
        formData.append("title", file.name.replace(/\.[^.]+$/, ""));
        formData.append("mediaType", uploadMediaType);
        const res = await fetch("/api/books", { method: "POST", body: formData });
        const data = await res.json();
        if (!data.success) throw new Error(data.message || "Upload failed");
      }

      setProgress(100);
      setUploadMsg("Upload complete!");
      await loadBooks();
      setTimeout(() => {
        setUploadOpen(false);
        setUploading(false);
        setProgress(0);
      }, 800);
    } catch (err) {
      setUploadMsg(`Upload failed: ${err instanceof Error ? err.message : "Unknown error"}`);
      setUploading(false);
    }
  };

  const createShelf = async () => {
    if (!newShelfName.trim()) return;
    await fetch("/api/shelves", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newShelfName }),
    });
    setNewShelfName("");
    setShowShelfInput(false);
    loadShelves();
  };

  const toggleFavorite = async (book: Book, e: React.MouseEvent) => {
    e.stopPropagation();
    await fetch(`/api/books/${book.id}/update`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_favorite: !book.is_favorite }),
    });
    loadBooks();
  };

  const cycleMediaType = async (book: Book, e: React.MouseEvent) => {
    e.stopPropagation();
    const next = MEDIA_CYCLE[(MEDIA_CYCLE.indexOf(book.media_type) + 1) % MEDIA_CYCLE.length];
    await fetch(`/api/books/${book.id}/update`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ media_type: next }),
    });
    loadBooks();
  };

  const deleteBook = async (book: Book, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`Delete "${book.title}"? This cannot be undone.`)) return;
    await fetch(`/api/books/${book.id}`, { method: "DELETE" });
    loadBooks();
  };

  const logout = async () => {
    await fetch("/api/auth", { method: "DELETE" });
    router.push("/");
    router.refresh();
  };

  const filtered = (books || []).filter((b) => {
    const q = search.toLowerCase();
    return (
      !q ||
      b.title?.toLowerCase().includes(q) ||
      b.author?.toLowerCase().includes(q) ||
      b.tags?.toLowerCase().includes(q)
    );
  });

  const [shelfBookIds, setShelfBookIds] = useState<Set<string> | null>(null);

  useEffect(() => {
    if (typeof filter === "string" && filter.startsWith("shelf:")) {
      const shelfId = filter.slice(6);
      fetch(`/api/shelves/${shelfId}/books`)
        .then((r) => (r.ok ? r.json() : { books: [] }))
        .then((d) => setShelfBookIds(new Set((d.books || []).map((b: { id: string }) => b.id))))
        .catch(() => setShelfBookIds(new Set()));
    } else {
      setShelfBookIds(null);
    }
  }, [filter]);

  const visible = (() => {
    if (shelfBookIds) return filtered.filter((b) => shelfBookIds.has(b.id));
    if (filter.startsWith("sec:")) return filtered.filter((b) => b.media_type === filter.slice(4));
    if (filter === "epub") return filtered.filter((b) => b.file_type === "epub");
    if (filter === "pdf") return filtered.filter((b) => b.file_type === "pdf");
    if (filter === "recent") return filtered.filter((b) => b.progress > 0);
    if (filter === "favorites") return filtered.filter((b) => b.is_favorite === 1);
    return filtered;
  })();

  const countFor = (f: Filter) =>
    f === "all" ? (books || []).length : (books || []).filter((b) => b.media_type === f.slice(4)).length;

  return (
    <div className="page-body">
      <nav className="navbar">
        <div className="nav-brand">
          <span>📚</span>
          <span>Nightmare Library</span>
        </div>
        <div className="nav-actions">
          <button className="btn-icon" onClick={() => setUploadOpen(true)} title="Upload Media">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
          </button>
          <button className="btn-icon btn-danger" onClick={logout} title="Logout">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </button>
        </div>
      </nav>

      <div className="dashboard-layout">
        <aside className="sidebar">
          <div className="sidebar-section">
            <h3 className="sidebar-label">Library</h3>
            <ul className="sidebar-menu">
              <li className={`sidebar-item ${filter === "all" ? "active" : ""}`} onClick={() => setFilter("all")}>
                All Media
                <span className="sidebar-count">{countFor("all")}</span>
              </li>
            </ul>
          </div>

          <div className="sidebar-section">
            <h3 className="sidebar-label">Sections</h3>
            <ul className="sidebar-menu">
              {SECTIONS.map((s) => (
                <li
                  key={s.key}
                  className={`sidebar-item ${filter === s.key ? "active" : ""}`}
                  onClick={() => setFilter(s.key)}
                >
                  <span>{s.icon}</span>
                  {s.label}
                  <span className="sidebar-count">{countFor(s.key)}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="sidebar-section">
            <h3 className="sidebar-label">Filters</h3>
            <ul className="sidebar-menu">
              <li className={`sidebar-item ${filter === "epub" ? "active" : ""}`} onClick={() => setFilter("epub")}>
                EPUBs
              </li>
              <li className={`sidebar-item ${filter === "pdf" ? "active" : ""}`} onClick={() => setFilter("pdf")}>
                PDFs
              </li>
              <li className={`sidebar-item ${filter === "recent" ? "active" : ""}`} onClick={() => setFilter("recent")}>
                In Progress
              </li>
              <li
                className={`sidebar-item ${filter === "favorites" ? "active" : ""}`}
                onClick={() => setFilter("favorites")}
              >
                Favorites
              </li>
            </ul>
          </div>

          <div className="sidebar-section">
            <h3 className="sidebar-label">
              Shelves
              <button className="btn-tiny" onClick={() => setShowShelfInput(!showShelfInput)} title="New Shelf">
                +
              </button>
            </h3>
            {showShelfInput && (
              <div style={{ padding: "0 16px 8px" }}>
                <input
                  value={newShelfName}
                  onChange={(e) => setNewShelfName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && createShelf()}
                  placeholder="Shelf name..."
                  className="sidebar-input"
                />
              </div>
            )}
            <ul className="sidebar-menu">
              {shelves.length === 0 ? (
                <li className="sidebar-empty">No shelves yet</li>
              ) : (
                shelves.map((s) => (
                  <li
                    key={s.id}
                    className={`sidebar-item ${filter === `shelf:${s.id}` ? "active" : ""}`}
                    onClick={() => setFilter(`shelf:${s.id}`)}
                  >
                    <span style={{ width: 10, height: 10, borderRadius: 3, background: s.color, flexShrink: 0 }} />
                    {s.name}
                    <span className="sidebar-count">{s.book_count}</span>
                  </li>
                ))
              )}
            </ul>
          </div>
        </aside>

        <main className="main-content">
          <div className="content-header">
            <div className="search-bar">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search your library..."
              />
            </div>
            <div className="view-controls">
              <button className={`btn-icon ${view === "grid" ? "active" : ""}`} onClick={() => setView("grid")}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="3" width="7" height="7" />
                  <rect x="14" y="3" width="7" height="7" />
                  <rect x="14" y="14" width="7" height="7" />
                  <rect x="3" y="14" width="7" height="7" />
                </svg>
              </button>
              <button className={`btn-icon ${view === "list" ? "active" : ""}`} onClick={() => setView("list")}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="8" y1="6" x2="21" y2="6" />
                  <line x1="8" y1="12" x2="21" y2="12" />
                  <line x1="8" y1="18" x2="21" y2="18" />
                </svg>
              </button>
            </div>
          </div>

          {books === null ? (
            <div className="loading-state">
              <div className="spinner" />
              <p>Loading your library...</p>
            </div>
          ) : visible.length === 0 ? (
            <div className="empty-state">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
              </svg>
              <h3>Nothing here yet</h3>
              <p>Upload media with the ↑ button.</p>
            </div>
          ) : (
            <div className={view === "grid" ? "books-grid" : "books-list"}>
              {visible.map((book) => (
                <div
                  key={book.id}
                  className="book-card"
                  style={{ position: "relative" }}
                  onClick={() => router.push(openTarget(book))}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === "Enter" && router.push(openTarget(book))}
                >
                  <div className="book-cover">
                    {book.cover_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={book.cover_url} alt={book.title} loading="lazy" />
                    ) : (
                      <div className="book-cover-placeholder">
                        {isVideo(book) ? (
                          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <polygon points="23 7 16 12 23 17 23 7" />
                            <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                          </svg>
                        ) : (
                          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                          </svg>
                        )}
                        <span>{book.file_type.toUpperCase()}</span>
                      </div>
                    )}
                    <span className={`book-type-badge media-${book.media_type}`}>
                      {MEDIA_LABELS[book.media_type] || book.file_type}
                    </span>
                    {book.is_favorite === 1 && <span className="book-favorite">♥</span>}
                  </div>
                  <div className="book-info">
                    <div className="book-title">{book.title}</div>
                    <div className="book-author">{book.author || "Unknown"}</div>
                    {book.progress > 0 && (
                      <div className="book-progress">
                        <div className="book-progress-fill" style={{ width: `${book.progress}%` }} />
                      </div>
                    )}
                  </div>
                  <div style={{ position: "absolute", top: 44, right: 8, display: "flex", gap: 4 }}>
                    <button className="btn-icon" onClick={(e) => cycleMediaType(book, e)} title="Move to section">
                      ⇄
                    </button>
                    <button className="btn-icon" onClick={(e) => toggleFavorite(book, e)} title="Favorite">
                      ♥
                    </button>
                    <button className="btn-icon btn-danger" onClick={(e) => deleteBook(book, e)} title="Delete">
                      ×
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </main>
      </div>

      {uploadOpen && (
        <div className="modal">
          <div className="modal-overlay" onClick={() => !uploading && setUploadOpen(false)} />
          <div className="modal-content">
            <div className="modal-header">
              <h2>Upload Media</h2>
              <button className="modal-close" onClick={() => !uploading && setUploadOpen(false)}>
                ×
              </button>
            </div>
            <div className="modal-body">
              {!uploading && (
                <div className="form-group" style={{ marginBottom: 16 }}>
                  <label>Add to section</label>
                  <select
                    value={uploadMediaType}
                    onChange={(e) => setUploadMediaType(e.target.value)}
                    className="select-input"
                  >
                    <option value="book">Books (PDF)</option>
                    <option value="ln">Light Novel (EPUB)</option>
                    <option value="manga">Manga (EPUB)</option>
                    <option value="anime_official">Anime (Official) — MP4 video</option>
                  </select>
                </div>
              )}
              {!uploading ? (
                <label
                  className="upload-drop-zone"
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.currentTarget.classList.add("drag-over");
                  }}
                  onDragLeave={(e) => e.currentTarget.classList.remove("drag-over")}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.currentTarget.classList.remove("drag-over");
                    const file = e.dataTransfer.files[0];
                    if (file) handleUpload(file);
                  }}
                  style={{ cursor: "pointer" }}
                >
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                  <p>Drop EPUB, PDF or MP4 here</p>
                  <span>or click to choose a file</span>
                  <input
                    type="file"
                    accept=".epub,.pdf,.mp4,.webm"
                    hidden
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleUpload(file);
                    }}
                  />
                </label>
              ) : (
                <div className="upload-progress">
                  <div className="progress-bar">
                    <div className="progress-fill" style={{ width: `${progress}%` }} />
                  </div>
                  <p>{uploadMsg}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
