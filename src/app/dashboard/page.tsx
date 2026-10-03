"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import BookCover from "@/components/BookCover";

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

interface UploadQueueItem {
  name: string;
  status: "pending" | "compressing" | "uploading" | "processing" | "done" | "error";
  percent: number;
  message?: string;
}

interface Stats {
  totalBooks: number;
  totalPages: number;
  favorites: number;
  inProgress: number;
  storageUsedBytes: number;
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
  { key: "sec:ln", label: "Light Novels", icon: "📖" },
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

type SortKey = "recent" | "title" | "author" | "progress";

const SORTS: { value: SortKey; label: string }[] = [
  { value: "recent", label: "Recently opened" },
  { value: "title", label: "Title A–Z" },
  { value: "author", label: "Author A–Z" },
  { value: "progress", label: "Furthest read" },
];

function greetingFor(hour: number): { title: string; sub: string } {
  if (hour < 5) return { title: "Burning the midnight oil", sub: "The quietest hours make the best reading." };
  if (hour < 12) return { title: "Good morning, reader", sub: "Fresh pages and a fresh pot of coffee." };
  if (hour < 17) return { title: "Good afternoon, reader", sub: "The afternoon light is kind to long chapters." };
  if (hour < 22) return { title: "Good evening, reader", sub: "The lamp is lit and the stories are waiting." };
  return { title: "Late-night tales await", sub: "One more chapter never hurt anyone." };
}

export default function DashboardPage() {
  const router = useRouter();
  const [books, setBooks] = useState<Book[] | null>(null);
  const [shelves, setShelves] = useState<Shelf[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadQueue, setUploadQueue] = useState<UploadQueueItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadMediaType, setUploadMediaType] = useState("book");
  const [newShelfName, setNewShelfName] = useState("");
  const [creatingShelf, setCreatingShelf] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [activity, setActivity] = useState<{ date: string; minutes: number }[]>([]);
  const [shelfPick, setShelfPick] = useState<Book | null>(null);
  const [shelfPickIds, setShelfPickIds] = useState<Set<string>>(new Set());
  const [greeting, setGreeting] = useState(() => greetingFor(12));
  const [sort, setSort] = useState<"recent" | "title" | "author" | "progress">("recent");
  const [goal, setGoalState] = useState(30);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQ, setPaletteQ] = useState("");
  const [paletteIdx, setPaletteIdx] = useState(0);

  const showToast = useCallback((kind: "ok" | "err", text: string) => {
    setToast({ kind, text });
    window.setTimeout(() => setToast(null), 2600);
  }, []);

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
    try {
      const res = await fetch("/api/shelves");
      if (res.ok) {
        const data = await res.json();
        setShelves(data.shelves || []);
      }
    } catch {
      // non-fatal
    }
  }, []);

  const loadStats = useCallback(async () => {
    try {
      const res = await fetch("/api/stats");
      if (res.ok) {
        const data = await res.json();
        setStats({
          totalBooks: data.stats?.totalBooks ?? 0,
          totalPages: data.stats?.totalPages ?? 0,
          favorites: data.stats?.favorites ?? 0,
          inProgress: data.stats?.inProgress ?? 0,
          storageUsedBytes: data.stats?.storageUsedBytes ?? 0,
        });
        setActivity(data.stats?.activity || []);
      }
    } catch {
      // non-fatal
    }
  }, []);

  useEffect(() => {
    loadBooks();
    loadShelves();
    loadStats();
    setGreeting(greetingFor(new Date().getHours()));
    const savedSort = localStorage.getItem("nmlr-sort");
    if (savedSort === "recent" || savedSort === "title" || savedSort === "author" || savedSort === "progress") {
      setSort(savedSort);
    }
    const savedGoal = parseInt(localStorage.getItem("nmlr-goal") || "", 10);
    if (!Number.isNaN(savedGoal) && savedGoal >= 5 && savedGoal <= 240) setGoalState(savedGoal);
  }, [loadBooks, loadShelves, loadStats]);

  const changeSort = (v: "recent" | "title" | "author" | "progress") => {
    setSort(v);
    localStorage.setItem("nmlr-sort", v);
  };

  const setGoal = (v: number) => {
    setGoalState(v);
    localStorage.setItem("nmlr-goal", String(v));
  };

  // Cmd/Ctrl-K opens the command palette from anywhere on the dashboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        setPaletteQ("");
        setPaletteIdx(0);
      }
      if (e.key === "Escape") setPaletteOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    setDrawerOpen(false);
  }, [filter]);

  const isVideo = (b: Book) => b.file_type === "mp4" || b.file_type === "webm" || b.file_type === "m4v";
  const openTarget = (b: Book) =>
    b.media_type === "anime_official" || isVideo(b) ? `/watch?id=${b.id}` : `/reader?id=${b.id}`;

  // ---------------- Upload ----------------
  // One file's journey: gzip (books) → presign → PUT to B2 → confirm.
  // `onPhase` reports progress for the queue UI; throws on failure.
  const uploadOne = async (
    file: File,
    mediaType: string,
    onPhase: (status: UploadQueueItem["status"], percent: number, message?: string) => void
  ) => {
    const name = file.name.toLowerCase();
    const fileType = name.endsWith(".epub")
      ? "epub"
      : name.endsWith(".pdf")
        ? "pdf"
        : name.endsWith(".mp4")
          ? "mp4"
          : name.endsWith(".webm")
            ? "webm"
            : name.endsWith(".m4v")
              ? "m4v"
              : null;
    if (!fileType) {
      throw new Error("Only EPUB, PDF and video files are supported");
    }

    // Client-side gzip for compressible book files; the server keeps
    // whichever encoding is smaller and decompresses on every read.
    const COMPRESSIBLE = fileType === "epub" || fileType === "pdf";
    let payload: Blob = file;
    let encoding = "raw";
    const originalSize = file.size;
    if (COMPRESSIBLE && typeof CompressionStream !== "undefined" && file.size >= 1024) {
      onPhase("compressing", 5);
      try {
        const cs = new CompressionStream("gzip");
        const stream = file.stream().pipeThrough(cs);
        const compressed = await new Response(stream).blob();
        if (compressed.size < file.size * 0.97) {
          payload = compressed;
          encoding = "gzip";
        }
      } catch {
        // browser limitation — upload raw
      }
    }

    onPhase("uploading", 10);
    const presignRes = await fetch("/api/books", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileType, mediaType }),
    });
    const presignData = await presignRes.json();

    if (presignData.success && presignData.presign) {
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", presignData.uploadUrl);
        xhr.setRequestHeader(
          "Content-Type",
          fileType === "epub" ? "application/epub+zip" : fileType === "pdf" ? "application/pdf" : `video/${fileType === "webm" ? "webm" : "mp4"}`
        );
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            onPhase("uploading", Math.max(10, Math.round((e.loaded / e.total) * 85) + 5));
          }
        };
        xhr.onload = () =>
          xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Storage upload failed (${xhr.status})`));
        xhr.onerror = () =>
          reject(
            new Error(
              xhr.status === 0
                ? "Browser blocked the upload — the B2 bucket needs a CORS rule allowing PUT from this site"
                : "Storage upload failed"
            )
          );
        xhr.send(payload);
      });

      onPhase("processing", 95);
      // Confirm carries the presign facts with it, so the server never needs
      // a same-instance memory lookup (serverless-safe).
      const confirmRes = await fetch("/api/books", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bookId: presignData.bookId,
          storageId: presignData.storageId,
          title: file.name.replace(/\.[^.]+$/, ""),
          mediaType,
          fileType,
          encoding,
          originalSize,
        }),
      });
      const confirmData = await confirmRes.json();
      if (!confirmData.success) throw new Error(confirmData.message || "Finalize failed");
    } else {
      onPhase("uploading", 30);
      const formData = new FormData();
      formData.append("file", payload, file.name);
      formData.append("title", file.name.replace(/\.[^.]+$/, ""));
      formData.append("mediaType", mediaType);
      formData.append("encoding", encoding);
      formData.append("originalSize", String(originalSize));
      const res = await fetch("/api/books", { method: "POST", body: formData });
      const data = await res.json();
      if (!data.success) throw new Error(data.message || "Upload failed");
    }
  };

  const handleUpload = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    setUploading(true);
    setUploadQueue(list.map((f) => ({ name: f.name, status: "pending" as const, percent: 0 })));

    let ok = 0;
    let fail = 0;
    for (let i = 0; i < list.length; i++) {
      const file = list[i];
      const update = (status: UploadQueueItem["status"], percent: number, message?: string) =>
        setUploadQueue((q) => q.map((item, idx) => (idx === i ? { ...item, status, percent, message } : item)));
      try {
        await uploadOne(file, uploadMediaType, update);
        update("done", 100);
        ok++;
      } catch (err) {
        update("error", 0, err instanceof Error ? err.message : "Unknown error");
        fail++;
      }
    }

    await Promise.all([loadBooks(), loadStats()]);
    if (list.length === 1) {
      const failed = fail > 0;
      showToast(failed ? "err" : "ok", failed ? "Upload failed" : `“${list[0].name.replace(/\.[^.]+$/, "")}” shelved`);
      if (!failed) {
        setTimeout(() => {
          setUploadOpen(false);
          setUploading(false);
          setUploadQueue([]);
        }, 800);
        return;
      }
    } else {
      showToast(fail === 0 ? "ok" : ok > 0 ? "ok" : "err", fail === 0 ? `${ok} books shelved` : `${ok} shelved, ${fail} failed`);
    }
    setUploading(false);
  };

  // ---------------- Shelves ----------------
  const createShelf = async () => {
    const name = newShelfName.trim();
    if (!name) return;
    setCreatingShelf(true);
    try {
      const res = await fetch("/api/shelves", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.success) {
        setNewShelfName("");
        showToast("ok", `Shelf “${name}” built`);
        await loadShelves();
      } else {
        showToast("err", data?.message || "Could not create shelf");
      }
    } catch {
      showToast("err", "Could not create shelf — network error");
    } finally {
      setCreatingShelf(false);
    }
  };

  const deleteShelf = async (shelf: Shelf) => {
    if (!confirm(`Tear down the shelf “${shelf.name}”? The books themselves are kept.`)) return;
    try {
      const res = await fetch(`/api/shelves/${shelf.id}`, { method: "DELETE" });
      if (res.ok) {
        if (filter === `shelf:${shelf.id}`) setFilter("all");
        showToast("ok", `Shelf “${shelf.name}” removed`);
        await loadShelves();
      } else {
        showToast("err", "Could not remove shelf");
      }
    } catch {
      showToast("err", "Could not remove shelf — network error");
    }
  };

  // ---------------- Book actions ----------------
  const refreshAll = useCallback(() => {
    loadBooks();
    loadStats();
  }, [loadBooks, loadStats]);

  const toggleFavorite = async (book: Book, e: React.MouseEvent) => {
    e.stopPropagation();
    setBooks((prev) =>
      (prev || []).map((b) => (b.id === book.id ? { ...b, is_favorite: b.is_favorite ? 0 : 1 } : b))
    );
    try {
      const res = await fetch(`/api/books/${book.id}/update`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_favorite: !book.is_favorite }),
      });
      if (!res.ok) throw new Error();
      loadStats();
    } catch {
      setBooks((prev) =>
        (prev || []).map((b) => (b.id === book.id ? { ...b, is_favorite: book.is_favorite } : b))
      );
      showToast("err", "Could not update favorite");
    }
  };

  const cycleMediaType = async (book: Book, e: React.MouseEvent) => {
    e.stopPropagation();
    const next = MEDIA_CYCLE[(MEDIA_CYCLE.indexOf(book.media_type) + 1) % MEDIA_CYCLE.length];
    setBooks((prev) => (prev || []).map((b) => (b.id === book.id ? { ...b, media_type: next } : b)));
    try {
      const res = await fetch(`/api/books/${book.id}/update`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ media_type: next }),
      });
      if (!res.ok) throw new Error();
      showToast("ok", `Moved to ${MEDIA_LABELS[next]}`);
      loadShelves();
    } catch {
      setBooks((prev) => (prev || []).map((b) => (b.id === book.id ? { ...b, media_type: book.media_type } : b)));
      showToast("err", "Could not move book");
    }
  };

  const deleteBook = async (book: Book, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`Remove “${book.title}” from the library? This cannot be undone.`)) return;
    setBooks((prev) => (prev || []).filter((b) => b.id !== book.id));
    try {
      const res = await fetch(`/api/books/${book.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      showToast("ok", `“${book.title}” removed`);
      refreshAll();
      loadShelves();
    } catch {
      showToast("err", "Delete failed");
      loadBooks();
    }
  };

  // ---------------- Shelf membership modal ----------------
  const openShelfPicker = async (book: Book, e: React.MouseEvent) => {
    e.stopPropagation();
    setShelfPick(book);
    setShelfPickIds(new Set());
    try {
      const res = await fetch("/api/shelves");
      const data = await res.json();
      const all: Shelf[] = data.shelves || [];
      const memberships = await Promise.all(
        all.map(async (s) => {
          const r = await fetch(`/api/shelves/${s.id}/books`);
          if (!r.ok) return null;
          const d = await r.json();
          return (d.books || []).some((b: { id: string }) => b.id === book.id) ? s.id : null;
        })
      );
      setShelfPickIds(new Set(memberships.filter(Boolean) as string[]));
    } catch {
      showToast("err", "Could not load shelves");
    }
  };

  const toggleShelfMembership = async (shelf: Shelf) => {
    if (!shelfPick) return;
    const bookId = shelfPick.id;
    const wasOn = shelfPickIds.has(shelf.id);
    setShelfPickIds((prev) => {
      const next = new Set(prev);
      if (wasOn) next.delete(shelf.id);
      else next.add(shelf.id);
      return next;
    });
    try {
      // Route reads bookId from the query string on DELETE (not the body).
      const res = await fetch(`/api/shelves/${shelf.id}/books?bookId=${encodeURIComponent(bookId)}`, {
        method: wasOn ? "DELETE" : "POST",
        headers: { "Content-Type": "application/json" },
        body: wasOn ? undefined : JSON.stringify({ bookId }),
      });
      if (!res.ok) throw new Error();
      loadShelves();
    } catch {
      setShelfPickIds((prev) => {
        const next = new Set(prev);
        if (wasOn) next.add(shelf.id);
        else next.delete(shelf.id);
        return next;
      });
      showToast("err", "Could not update shelf");
    }
  };

  const logout = async () => {
    await fetch("/api/auth", { method: "DELETE" });
    router.push("/");
    router.refresh();
  };

  // ---------------- Derived data ----------------
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    const list = (books || []).filter(
      (b) =>
        !q ||
        b.title?.toLowerCase().includes(q) ||
        b.author?.toLowerCase().includes(q) ||
        b.tags?.toLowerCase().includes(q)
    );
    if (sort === "recent") return list; // server order: last read, then shelved
    const collator = new Intl.Collator(undefined, { sensitivity: "base" });
    if (sort === "title") return [...list].sort((a, b) => collator.compare(a.title || "", b.title || ""));
    if (sort === "author") return [...list].sort((a, b) => collator.compare(a.author || "", b.author || ""));
    return [...list].sort(
      (a, b) => (b.progress > 0 ? 1 : 0) - (a.progress > 0 ? 1 : 0) || b.progress - a.progress
    );
  }, [books, search, sort]);

  // Streak: consecutive days read, ending today (or yesterday — today's
  // session hasn't happened yet until the lamps are lit).
  const streak = useMemo(() => {
    const read = new Set(activity.filter((a) => a.minutes > 0.02).map((a) => a.date));
    let streak = 0;
    const d = new Date();
    if (!read.has(d.toISOString().slice(0, 10))) d.setDate(d.getDate() - 1);
    while (read.has(d.toISOString().slice(0, 10))) {
      streak++;
      d.setDate(d.getDate() - 1);
    }
    return streak;
  }, [activity]);

  const todayMinutes = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    return activity.find((a) => a.date === today)?.minutes ?? 0;
  }, [activity]);

  // Command palette items: books first, then navigation, then actions.
  const paletteItems = useMemo(() => {
    const q = paletteQ.trim().toLowerCase();
    const close = () => setPaletteOpen(false);
    const items: { group: string; icon: string; label: string; hint: string; run: () => void }[] = [];
    const matched = (books || [])
      .filter((b) => !q || b.title?.toLowerCase().includes(q) || b.author?.toLowerCase().includes(q))
      .slice(0, q ? 8 : 6);
    for (const b of matched) {
      items.push({
        group: "Books",
        icon: b.file_type === "epub" ? "📖" : b.file_type === "pdf" ? "📄" : "🎞",
        label: b.title,
        hint: b.author || MEDIA_LABELS[b.media_type] || "",
        run: () => {
          router.push(openTarget(b));
          close();
        },
      });
    }
    const navItems: [string, string, Filter][] = [
      ["◈", "Currently Reading", "recent"],
      ["♥", "Favorites", "favorites"],
      ["▦", "All Media", "all"],
      ...SECTIONS.map((s) => [s.icon, s.label, s.key] as [string, string, Filter]),
      ...shelves.map((s) => ["◧", s.name, `shelf:${s.id}` as Filter] as [string, string, Filter]),
    ];
    for (const [icon, label, f] of navItems) {
      if (q && !label.toLowerCase().includes(q)) continue;
      items.push({ group: "Go to", icon, label, hint: "shelf", run: () => { setFilter(f); close(); } });
    }
    items.push({ group: "Actions", icon: "↑", label: "Add a book", hint: "upload", run: () => { setUploadOpen(true); close(); } });
    items.push({ group: "Actions", icon: "⚙", label: "Settings", hint: "", run: () => { router.push("/settings"); close(); } });
    if ((books || []).length > 0) {
      items.push({
        group: "Actions",
        icon: "✦",
        label: "Surprise me",
        hint: "random book",
        run: () => {
          const pool = books || [];
          router.push(openTarget(pool[Math.floor(Math.random() * pool.length)]));
          close();
        },
      });
    }
    return items;
  }, [books, paletteQ, router, shelves]);

  const [shelfBookIds, setShelfBookIds] = useState<Set<string> | null>(null);

  useEffect(() => {
    if (typeof filter === "string" && filter.startsWith("shelf:")) {
      const shelfId = filter.slice(6);
      let cancelled = false;
      fetch(`/api/shelves/${shelfId}/books`)
        .then((r) => (r.ok ? r.json() : { books: [] }))
        .then((d) => {
          if (!cancelled) setShelfBookIds(new Set((d.books || []).map((b: { id: string }) => b.id)));
        })
        .catch(() => setShelfBookIds(new Set()));
      return () => {
        cancelled = true;
      };
    }
    setShelfBookIds(null);
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

  const continueReading = (books || [])
    .filter((b) => b.progress > 0 && b.progress < 100)
    .sort((a, b) => b.progress - a.progress)
    .slice(0, 8);

  const countFor = (f: Filter) => {
    if (f === "all") return (books || []).length;
    if (f === "epub") return (books || []).filter((b) => b.file_type === "epub").length;
    if (f === "pdf") return (books || []).filter((b) => b.file_type === "pdf").length;
    if (f === "recent") return (books || []).filter((b) => b.progress > 0).length;
    if (f === "favorites") return (books || []).filter((b) => b.is_favorite === 1).length;
    if (f.startsWith("sec:")) return (books || []).filter((b) => b.media_type === f.slice(4)).length;
    return 0;
  };

  const currentFilterLabel = (() => {
    if (filter === "all") return "The Whole Collection";
    if (filter === "epub") return "EPUBs";
    if (filter === "pdf") return "PDFs";
    if (filter === "recent") return "Currently Reading";
    if (filter === "favorites") return "Marked with a Heart";
    if (filter.startsWith("sec:")) return SECTIONS.find((s) => s.key === filter)?.label ?? filter;
    const shelf = shelves.find((s) => s.id === filter.slice(6));
    return shelf ? shelf.name : "Shelf";
  })();

  const [addShelfOpen, setAddShelfOpen] = useState(false);

  const fmtBytes = (n: number) => {
    if (n >= 1024 * 1024 * 1024) return `${(n / 1024 ** 3).toFixed(1)} GB`;
    if (n >= 1024 * 1024) return `${(n / 1024 ** 2).toFixed(0)} MB`;
    if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${n} B`;
  };

  const overlayButtons = (book: Book) => (
    <div className="book-overlay" onClick={(e) => e.stopPropagation()}>
      <button className="btn-icon" onClick={(e) => openShelfPicker(book, e)} title="Add to shelf" aria-label="Add to shelf">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
        </svg>
      </button>
      <button className="btn-icon" onClick={(e) => cycleMediaType(book, e)} title={`Section: ${MEDIA_LABELS[book.media_type] || book.media_type} (click to move)`} aria-label="Move to section">
        ⇄
      </button>
      <button
        className={`btn-icon ${book.is_favorite === 1 ? "fav-on" : ""}`}
        onClick={(e) => toggleFavorite(book, e)}
        title="Favorite"
        aria-label="Favorite"
      >
        ♥
      </button>
      <button className="btn-icon" onClick={(e) => refreshBook(book, e)} title="Re-read cover & details from the file" aria-label="Refresh details">
        ↻
      </button>
      <button className="btn-icon btn-danger" onClick={(e) => deleteBook(book, e)} title="Delete" aria-label="Delete">
        ×
      </button>
    </div>
  );

  // Re-read the stored file to repair the row: pull the EPUB's own cover and
  // title/author. Books uploaded before that parsing existed are repaired by
  // this (and automatically when their cover 404s on the grid).
  const refreshBook = async (book: Book, e: React.MouseEvent) => {
    e.stopPropagation();
    showToast("ok", `Re-reading “${book.title}”…`);
    try {
      const res = await fetch(`/api/books/${book.id}/refresh`, { method: "POST" });
      const data = await res.json();
      if (!data.success) {
        showToast("err", data.message || "Could not refresh");
        return;
      }
      await loadBooks();
      const changed = (data.changed || []) as string[];
      showToast(
        "ok",
        changed.length
          ? `“${data.title}” — fixed ${changed.join(", ")}`
          : data.minutes
            ? `“${data.title}” — nothing to fix, ~${data.minutes} min read`
            : `“${data.title}” — nothing to fix`
      );
    } catch {
      showToast("err", "Refresh failed");
    }
  };

  const coverBlock = (book: Book) => (
    <div className="book-cover">
      <BookCover
        bookId={book.id}
        coverUrl={book.cover_url}
        title={book.title}
        author={book.author}
        kicker={isVideo(book) ? "Film" : MEDIA_LABELS[book.media_type] || book.file_type.toUpperCase()}
      />
      <span className={`book-type-badge media-${book.media_type}`}>
        {MEDIA_LABELS[book.media_type] || book.file_type}
      </span>
      {book.is_favorite === 1 && <span className="book-favorite">♥</span>}
    </div>
  );

  return (
    <div className="page-body">
      <nav className="navbar">
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <button className="btn-icon menu-btn" onClick={() => setDrawerOpen(true)} title="Menu" aria-label="Open menu">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <div className="nav-brand">
            <span className="brand-mark">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
                <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
              </svg>
            </span>
            <span className="brand-text">Nightmare Library</span>
          </div>
        </div>
        <div className="nav-actions">
          <button className="btn-icon" onClick={() => router.push("/settings")} title="Settings" aria-label="Settings">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
          <button className="btn-icon" onClick={() => setUploadOpen(true)} title="Add a book" aria-label="Add a book">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
          </button>
          <button className="btn-icon btn-danger" onClick={logout} title="Close the door" aria-label="Log out">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </button>
        </div>
      </nav>

      <div className="dashboard-layout">
        <div className={`overlay ${drawerOpen ? "open" : ""}`} onClick={() => setDrawerOpen(false)} />

        <aside className={`sidebar ${drawerOpen ? "open" : ""}`}>
          <div>
            <h3 className="sidebar-label">Library</h3>
            <ul className="sidebar-menu">
              <li
                className={`sidebar-item ${filter === "all" ? "active" : ""}`}
                onClick={() => setFilter("all")}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === "Enter" && setFilter("all")}
              >
                All Media
                <span className="sidebar-count">{countFor("all")}</span>
              </li>
            </ul>
          </div>

          <div>
            <h3 className="sidebar-label">Sections</h3>
            <ul className="sidebar-menu">
              {SECTIONS.map((s) => (
                <li
                  key={s.key}
                  className={`sidebar-item ${filter === s.key ? "active" : ""}`}
                  onClick={() => setFilter(s.key)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === "Enter" && setFilter(s.key)}
                >
                  <span>{s.icon}</span>
                  {s.label}
                  <span className="sidebar-count">{countFor(s.key)}</span>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h3 className="sidebar-label">Filters</h3>
            <ul className="sidebar-menu">
              <li className={`sidebar-item ${filter === "recent" ? "active" : ""}`} onClick={() => setFilter("recent")} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && setFilter("recent")}>
                Currently Reading
                <span className="sidebar-count">{countFor("recent")}</span>
              </li>
              <li className={`sidebar-item ${filter === "favorites" ? "active" : ""}`} onClick={() => setFilter("favorites")} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && setFilter("favorites")}>
                Favorites
                <span className="sidebar-count">{countFor("favorites")}</span>
              </li>
              <li className={`sidebar-item ${filter === "epub" ? "active" : ""}`} onClick={() => setFilter("epub")} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && setFilter("epub")}>
                EPUBs
                <span className="sidebar-count">{countFor("epub")}</span>
              </li>
              <li className={`sidebar-item ${filter === "pdf" ? "active" : ""}`} onClick={() => setFilter("pdf")} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && setFilter("pdf")}>
                PDFs
                <span className="sidebar-count">{countFor("pdf")}</span>
              </li>
            </ul>
          </div>

          <div>
            <h3 className="sidebar-label">
              Shelves
              <button className="btn-tiny" onClick={() => setAddShelfOpen((v) => !v)} title="New shelf" aria-label="New shelf">
                +
              </button>
            </h3>
            {addShelfOpen && (
              <form
                className="shelf-add-row"
                onSubmit={(e) => {
                  e.preventDefault();
                  createShelf();
                }}
              >
                <input
                  className="sidebar-input"
                  value={newShelfName}
                  onChange={(e) => setNewShelfName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setAddShelfOpen(false);
                  }}
                  placeholder="New shelf name"
                  autoFocus
                  maxLength={60}
                  aria-label="New shelf name"
                />
                <button type="submit" className="shelf-add-btn" disabled={creatingShelf} aria-label="Create shelf">
                  {creatingShelf ? "…" : "Add"}
                </button>
              </form>
            )}
            <ul className="sidebar-menu">
              {shelves.length === 0 ? (
                <li className="sidebar-empty">
                  {addShelfOpen ? "Name it, then tap Add" : "No shelves yet — tap +"}
                </li>
              ) : (
                shelves.map((s) => (
                  <li
                    key={s.id}
                    className={`sidebar-item sidebar-shelf-row ${filter === `shelf:${s.id}` ? "active" : ""}`}
                    onClick={() => setFilter(`shelf:${s.id}`)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => e.key === "Enter" && setFilter(`shelf:${s.id}`)}
                  >
                    <span style={{ width: 10, height: 10, borderRadius: 3, background: s.color, flexShrink: 0 }} />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</span>
                    <span className="sidebar-count">{s.book_count}</span>
                    <button
                      className="shelf-delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteShelf(s);
                      }}
                      title={`Remove shelf “${s.name}”`}
                      aria-label={`Remove shelf ${s.name}`}
                    >
                      ×
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>

          <div className="sidebar-footer">
            {stats ? (
              <>
                <b>{stats.totalBooks}</b> {stats.totalBooks === 1 ? "story" : "stories"} on the shelves ·{" "}
                <b>{fmtBytes(stats.storageUsedBytes)}</b> of ink and paper.
              </>
            ) : (
              "The shelves are being dusted…"
            )}
          </div>
        </aside>

        <main className="main-content">
          <div className="content-header">
            <div className="search-bar">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search the shelves…"
                aria-label="Search library"
              />
              {search && (
                <button className="btn-icon" style={{ width: 22, height: 22, minHeight: 22 }} onClick={() => setSearch("")} aria-label="Clear search">
                  ×
                </button>
              )}
            </div>
            <div className="view-controls">
              <button
                className="btn-icon bordered palette-trigger"
                onClick={() => {
                  setPaletteQ("");
                  setPaletteIdx(0);
                  setPaletteOpen(true);
                }}
                title="Command palette (⌘K)"
                aria-label="Open command palette"
              >
                <span className="kbd-glyph">⌘K</span>
              </button>
              <label className="sort-select" title="Sort the shelves">
                <span className="sort-label">Sort</span>
                <select
                  className="select-input sort-input"
                  value={sort}
                  onChange={(e) => changeSort(e.target.value as SortKey)}
                  aria-label="Sort books"
                >
                  {SORTS.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
              <button className={`btn-icon bordered ${view === "grid" ? "active" : ""}`} onClick={() => setView("grid")} title="Grid view" aria-label="Grid view">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="3" width="7" height="7" />
                  <rect x="14" y="3" width="7" height="7" />
                  <rect x="14" y="14" width="7" height="7" />
                  <rect x="3" y="14" width="7" height="7" />
                </svg>
              </button>
              <button className={`btn-icon bordered ${view === "list" ? "active" : ""}`} onClick={() => setView("list")} title="List view" aria-label="List view">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="8" y1="6" x2="21" y2="6" />
                  <line x1="8" y1="12" x2="21" y2="12" />
                  <line x1="8" y1="18" x2="21" y2="18" />
                </svg>
              </button>
            </div>
          </div>

          {filter === "all" && (
            <div className="greeting">
              <h2>{greeting.title}</h2>
              <p>{greeting.sub}</p>
            </div>
          )}

          {filter === "all" && continueReading.length > 0 && (
            <div className="continue-shelf">
              <h3>
                <span className="shelf-glyph">◈</span> Continue where you left off
              </h3>
              <div className="continue-row">
                {continueReading.map((book) => (
                  <div
                    key={book.id}
                    className="continue-card"
                    onClick={() => router.push(openTarget(book))}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => e.key === "Enter" && router.push(openTarget(book))}
                  >
                    {coverBlock(book)}
                    <div className="cc-title">{book.title}</div>
                    <div className="cc-pct">{book.progress}% read</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {stats && (
            <div className="stat-strip">
              <div className="stat-card">
                <div className="stat-value">{stats.totalBooks}</div>
                <div className="stat-label">Stories</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{stats.inProgress}</div>
                <div className="stat-label">In progress</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{stats.favorites}</div>
                <div className="stat-label">Favorites</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{fmtBytes(stats.storageUsedBytes)}</div>
                <div className="stat-label">On the shelves</div>
              </div>
            </div>
          )}

          {activity.length > 0 && (
            <div className="ritual-card">
              <div className="goal-ring" role="img" aria-label={`${Math.round(todayMinutes)} of ${goal} minutes read today`}>
                <svg viewBox="0 0 64 64" aria-hidden="true">
                  <circle className="goal-track" cx="32" cy="32" r="26" />
                  <circle
                    className={`goal-fill ${todayMinutes >= goal ? "met" : ""}`}
                    cx="32"
                    cy="32"
                    r="26"
                    strokeDasharray={`${Math.min(1, goal > 0 ? todayMinutes / goal : 0) * 163.36} 163.36`}
                  />
                </svg>
                <span className="goal-num">{Math.round(todayMinutes)}</span>
              </div>
              <div className="ritual-body">
                <div className="ritual-title">
                  {streak > 0
                    ? `${streak} night${streak === 1 ? "" : "s"} in a row at the lamp`
                    : todayMinutes >= goal
                      ? "Tonight's reading ritual is complete"
                      : "Tonight's reading ritual"}
                </div>
                <div className="ritual-sub">
                  {todayMinutes >= goal
                    ? `You read ${Math.round(todayMinutes)} min against a ${goal} min goal. Close the book satisfied.`
                    : `${Math.max(0, goal - Math.round(todayMinutes))} more minutes to tonight's goal of ${goal}.`}
                </div>
                <div className="ritual-goal">
                  <span>Daily goal</span>
                  <div className="goal-stepper">
                    <button onClick={() => setGoal(Math.max(5, goal - 5))} aria-label="Decrease daily goal">−</button>
                    <b>{goal}m</b>
                    <button onClick={() => setGoal(Math.min(240, goal + 5))} aria-label="Increase daily goal">+</button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activity.some((a) => a.minutes > 0) && (
            <div className="activity-card">
              <div className="activity-header">
                <span className="activity-title">Reading by candlelight — last 14 days</span>
                <span className="activity-total">{Math.round(activity.reduce((s, a) => s + a.minutes, 0))} min</span>
              </div>
              <svg className="activity-chart" viewBox={`0 0 ${Math.max(1, activity.length) * 24} 64`} preserveAspectRatio="none">
                {activity.map((a, i) => {
                  const MAX_MIN = Math.max(30, ...activity.map((x) => x.minutes));
                  const h = Math.max(2, (a.minutes / MAX_MIN) * 58);
                  return (
                    <rect key={a.date} x={i * 24 + 4} y={64 - h} width={16} height={h} rx={3} className="activity-bar">
                      <title>{`${a.date}: ${a.minutes} min`}</title>
                    </rect>
                  );
                })}
              </svg>
              <div className="activity-axis">
                <span>{activity[0]?.date.slice(5)}</span>
                <span>today</span>
              </div>
            </div>
          )}

          {filter !== "all" && (
            <div className="ink-rule" style={{ margin: "4px 0 18px" }}>
              {currentFilterLabel} · {visible.length} {visible.length === 1 ? "tale" : "tales"}
            </div>
          )}

          {books === null ? (
            <div className="loading-state">
              <div className="spinner" />
              <p>Lighting the lamps…</p>
            </div>
          ) : visible.length === 0 ? (
            <div className="empty-state">
              <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
                <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
              </svg>
              <h3>{search ? "No matches on this shelf" : "An empty shelf, waiting"}</h3>
              <p>
                {search
                  ? `Nothing here answers to “${search}”.`
                  : "Every library starts with one book. Upload an EPUB, PDF or video with the ↑ button above."}
              </p>
            </div>
          ) : view === "grid" ? (
            <div className="books-grid">
              {visible.map((book) => (
                <div
                  key={book.id}
                  className="book-card"
                  onClick={() => router.push(openTarget(book))}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === "Enter" && router.push(openTarget(book))}
                >
                  {coverBlock(book)}
                  {overlayButtons(book)}
                  <div className="book-info">
                    <div className="book-title">{book.title}</div>
                    <div className="book-author">{book.author || "Unknown hand"}</div>
                    {book.progress > 0 && (
                      <div className="book-progress">
                        <div className="book-progress-fill" style={{ width: `${book.progress}%` }} />
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="books-list">
              {visible.map((book) => (
                <div
                  key={book.id}
                  className="book-row"
                  onClick={() => router.push(openTarget(book))}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === "Enter" && router.push(openTarget(book))}
                >
                  <div className="row-cover">
                    <BookCover
                      bookId={book.id}
                      coverUrl={book.cover_url}
                      title={book.title}
                      author={book.author}
                      kicker={isVideo(book) ? "Film" : MEDIA_LABELS[book.media_type] || book.file_type.toUpperCase()}
                    />
                  </div>
                  <div className="row-main">
                    <div className="row-title">{book.title}</div>
                    <div className="row-sub">
                      {MEDIA_LABELS[book.media_type] || book.file_type} · {book.author || "Unknown hand"}
                      {book.is_favorite === 1 ? " · ♥" : ""}
                    </div>
                  </div>
                  <div className="row-progress">
                    {book.progress > 0 ? (
                      <>
                        <div className="row-sub" style={{ fontSize: 11 }}>{book.progress}%</div>
                        <div className="book-progress">
                          <div className="book-progress-fill" style={{ width: `${book.progress}%` }} />
                        </div>
                      </>
                    ) : null}
                  </div>
                  <div className="row-actions">{overlayButtons(book)}</div>
                </div>
              ))}
            </div>
          )}
        </main>
      </div>

      {/* Shelf membership picker */}
      {shelfPick && (
        <div className="modal" onClick={(e) => e.target === e.currentTarget && setShelfPick(null)}>
          <div className="modal-overlay" onClick={() => setShelfPick(null)} />
          <div className="modal-content" style={{ maxWidth: 380 }}>
            <div className="modal-header">
              <h2 style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                Shelve: {shelfPick.title}
              </h2>
              <button className="modal-close" onClick={() => setShelfPick(null)} aria-label="Close">
                ×
              </button>
            </div>
            <div className="modal-body">
              {shelves.length === 0 ? (
                <p style={{ fontSize: 13.5, color: "var(--text-muted)", lineHeight: 1.6, fontFamily: "var(--serif)", fontStyle: "italic" }}>
                  No shelves exist yet. Build one with the + beside “Shelves” in the menu, then return here.
                </p>
              ) : (
                <div className="shelf-pick-list">
                  {shelves.map((s) => (
                    <button key={s.id} className={`shelf-pick-item ${shelfPickIds.has(s.id) ? "on" : ""}`} onClick={() => toggleShelfMembership(s)}>
                      <span className="swatch" style={{ background: s.color }} />
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</span>
                      {shelfPickIds.has(s.id) && <span className="pick-check">✓</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Upload modal */}
      {uploadOpen && (
        <div className="modal" onClick={(e) => e.target === e.currentTarget && !uploading && setUploadOpen(false)}>
          <div className="modal-overlay" onClick={() => !uploading && setUploadOpen(false)} />
          <div className="modal-content">
            <div className="modal-header">
              <h2>Add to the shelves</h2>
              <button className="modal-close" onClick={() => !uploading && setUploadOpen(false)} aria-label="Close">
                ×
              </button>
            </div>
            <div className="modal-body">
              {!uploading && (
                <div className="form-group" style={{ marginBottom: 16 }}>
                  <label>Which section does it belong to?</label>
                  <select value={uploadMediaType} onChange={(e) => setUploadMediaType(e.target.value)} className="select-input">
                    <option value="book">Books (PDF)</option>
                    <option value="ln">Light Novel (EPUB)</option>
                    <option value="manga">Manga (EPUB)</option>
                    <option value="anime_official">Anime (Official) — video</option>
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
                    if (e.dataTransfer.files.length > 0) handleUpload(e.dataTransfer.files);
                  }}
                  style={{ cursor: "pointer" }}
                >
                  <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                  <p>Drop EPUB, PDF or video files here</p>
                  <span>or click to choose — select several at once for a batch upload</span>
                  <input
                    type="file"
                    accept=".epub,.pdf,.mp4,.webm,.m4v"
                    multiple
                    hidden
                    onChange={(e) => {
                      if (e.target.files && e.target.files.length > 0) handleUpload(e.target.files);
                      e.target.value = "";
                    }}
                  />
                </label>
              ) : (
                <div className="upload-queue">
                  {uploadQueue.map((item, i) => (
                    <div key={i} className={`upload-row ${item.status}`}>
                      <div className="upload-row-top">
                        <span className="upload-row-name" title={item.name}>
                          {item.status === "done" ? "✓ " : item.status === "error" ? "× " : ""}
                          {item.name}
                        </span>
                        <span className="upload-row-status">
                          {item.status === "pending"
                            ? "Waiting…"
                            : item.status === "compressing"
                              ? "Compressing…"
                              : item.status === "uploading"
                                ? `${item.percent}%`
                                : item.status === "processing"
                                  ? "Finishing…"
                                  : item.status === "done"
                                    ? "Shelved"
                                    : item.message || "Failed"}
                        </span>
                      </div>
                      <div className="upload-row-bar">
                        <div
                          className={`upload-row-fill ${item.status === "error" ? "err" : ""}`}
                          style={{ width: `${item.status === "error" ? 100 : item.percent}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {paletteOpen && (
        <div
          className="palette-backdrop"
          onClick={(e) => e.target === e.currentTarget && setPaletteOpen(false)}
        >
          <div
            className="palette"
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setPaletteIdx((i) => (paletteItems.length ? (i + 1) % paletteItems.length : 0));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setPaletteIdx((i) => (paletteItems.length ? (i - 1 + paletteItems.length) % paletteItems.length : 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                paletteItems[paletteIdx]?.run();
              } else if (e.key === "Escape") {
                setPaletteOpen(false);
              }
            }}
          >
            <input
              className="palette-input"
              autoFocus
              value={paletteQ}
              onChange={(e) => {
                setPaletteQ(e.target.value);
                setPaletteIdx(0);
              }}
              placeholder="Find a book, a shelf, an action…"
              aria-label="Command palette query"
            />
            <div className="palette-list">
              {paletteItems.length === 0 ? (
                <div className="palette-empty">Nothing in the stacks answers to that.</div>
              ) : (
                paletteItems.map((item, i) => (
                  <div key={`${item.group}-${item.label}-${i}`} className="palette-group">
                    {(i === 0 || paletteItems[i - 1].group !== item.group) && (
                      <div className="palette-group-label">{item.group}</div>
                    )}
                    <button
                      className={`palette-item ${i === paletteIdx ? "on" : ""}`}
                      onClick={() => item.run()}
                    >
                      <span className="palette-icon">{item.icon}</span>
                      <span className="palette-text">
                        <span className="palette-item-label">{item.label}</span>
                        {item.hint && <span className="palette-item-hint">{item.hint}</span>}
                      </span>
                    </button>
                  </div>
                ))
              )}
            </div>
            <div className="palette-foot">
              <span>↑ ↓ to move</span>
              <span>↵ to open</span>
              <span>esc to dismiss</span>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="toast-wrap">
          <div className={`toast ${toast.kind}`}>{toast.text}</div>
        </div>
      )}
    </div>
  );
}
