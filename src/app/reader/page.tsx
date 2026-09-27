"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function ReaderInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const id = searchParams.get("id");

  const [book, setBook] = useState<{ title: string; file_type: string } | null>(null);
  const [error, setError] = useState("");
  const [dark, setDark] = useState(true);
  const [fontSize, setFontSize] = useState(16);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<{ chapter: string; snippet: string }[]>([]);

  const viewerRef = useRef<HTMLDivElement>(null);
  const renditionRef = useRef<{ destroy: () => void } | null>(null);
  const percentRef = useRef(0);
  const savingRef = useRef(false);

  // Load theme + font size preferences
  useEffect(() => {
    const saved = localStorage.getItem("theme");
    const isDark = saved ? saved === "dark" : true;
    setDark(isDark);
    setFontSize(parseInt(localStorage.getItem("reader-font-size") || "16", 10));
  }, []);

  const toggleTheme = () => {
    const next = !dark;
    setDark(next);
    document.body.classList.toggle("dark-theme", next);
    localStorage.setItem("theme", next ? "dark" : "light");
  };

  // Save progress on unload/interval
  const saveProgress = useCallback(async () => {
    if (!id || savingRef.current) return;
    savingRef.current = true;
    try {
      await fetch(`/api/books/${id}/progress`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ percent: Math.round(percentRef.current) }),
      });
    } finally {
      savingRef.current = false;
    }
  }, [id]);

  useEffect(() => {
    const handler = () => {
      if (percentRef.current > 0) {
        navigator.sendBeacon?.(
          `/api/books/${id}/progress`,
          new Blob([JSON.stringify({ percent: Math.round(percentRef.current) })], {
            type: "application/json",
          })
        );
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [id]);

  // Load the book
  useEffect(() => {
    if (!id) {
      setError("No book specified.");
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(`/api/books/${id}`);
        if (!res.ok) throw new Error("Book not found");
        const data = await res.json();
        if (cancelled) return;

        setBook({ title: data.book.title, file_type: data.book.file_type });
        document.title = `${data.book.title} — Nightmare Library`;

        const saved = await fetch(`/api/books/${id}/progress`);
        const savedData = await saved.json();
        const initialPercent = Number(savedData.progress?.percent ?? 0);

        const fileRes = await fetch(`/api/books/${id}/file`);
        if (!fileRes.ok) throw new Error("Failed to load book file");

        if (data.book.file_type === "epub") {
          const ePub = (await import("epubjs")).default;
          const buffer = await fileRes.arrayBuffer();
          const epub = ePub(buffer as unknown as ArrayBuffer);
          const rendition = epub.renderTo(viewerRef.current!, {
            width: "100%",
            height: "100%",
          });
          renditionRef.current = rendition;
          await rendition.display();
          rendition.on("relocated", (location: { start: { percentage: number } }) => {
            if (location?.start?.percentage != null) {
              percentRef.current = location.start.percentage * 100;
            }
          });
          if (initialPercent > 0 && initialPercent < 100) {
            try {
              await (epub as unknown as { locations: { generate(chars: number): Promise<void> } }).locations.generate(1024);
              const total = (epub as unknown as { locations: { length(): number } }).locations.length();
              const target = Math.floor((initialPercent / 100) * total);
              if (target > 0) await rendition.display(target);
            } catch {
              // locations generation can be slow for big books; skip resume silently
            }
          }
        } else {
          // PDF — native browser viewer via data URL would be huge; use blob URL embed
          const blob = await fileRes.blob();
          const url = URL.createObjectURL(blob);
          const embed = document.createElement("embed");
          embed.src = url;
          embed.type = "application/pdf";
          embed.style.cssText = "width:100%;height:100%;border:none;";
          const container = document.getElementById("pdf-container");
          if (container) {
            container.appendChild(embed);
          }
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load book");
      }
    })();

    return () => {
      cancelled = true;
      renditionRef.current?.destroy();
    };
  }, [id]);

  // Periodic progress save while reading
  useEffect(() => {
    const interval = setInterval(saveProgress, 30000);
    return () => clearInterval(interval);
  }, [saveProgress]);

  const changeFont = (delta: number) => {
    setFontSize((prev) => {
      const next = Math.max(10, Math.min(28, prev + delta));
      localStorage.setItem("reader-font-size", String(next));
      try {
        (renditionRef.current as unknown as { themes: { fontSize: (s: string) => void } })?.themes?.fontSize(
          `${next}px`
        );
      } catch {
        // rendition may not exist (PDF mode)
      }
      return next;
    });
  };

  const doSearch = async () => {
    if (!id || searchQuery.trim().length < 2) return;
    const res = await fetch(`/api/books/${id}/search?q=${encodeURIComponent(searchQuery)}`);
    const data = await res.json();
    setSearchResults(data.results || []);
  };

  const goFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  };

  if (error) {
    return (
      <div className="reader-body" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div className="reader-loading">
          <p>{error}</p>
          <button className="btn-primary" onClick={() => router.push("/dashboard")}>
            Back to Library
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="reader-body">
      <div className="reader-toolbar">
        <div className="toolbar-left">
          <button className="btn-icon" onClick={() => router.push("/dashboard")} title="Back to Library">
            ←
          </button>
          <div className="book-title-bar">{book?.title || "Loading..."}</div>
        </div>
        <div className="toolbar-right">
          <button className="btn-icon" onClick={() => setShowSearch(!showSearch)} title="Search in book">
            🔍
          </button>
          <button className="btn-icon" onClick={() => changeFont(-2)} title="Decrease Font Size">
            A-
          </button>
          <button className="btn-icon" onClick={() => changeFont(2)} title="Increase Font Size">
            A+
          </button>
          <button className="btn-icon" onClick={toggleTheme} title="Toggle Theme">
            {dark ? "☀" : "🌙"}
          </button>
          <button className="btn-icon" onClick={goFullscreen} title="Fullscreen">
            ⛶
          </button>
        </div>
      </div>

      {showSearch && (
        <div style={{ padding: "8px 16px", background: "var(--bg-secondary)", borderBottom: "1px solid var(--border-color)" }}>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && doSearch()}
              placeholder="Search in this book..."
              style={{
                flex: 1,
                padding: "8px 12px",
                background: "var(--bg-primary)",
                border: "1px solid var(--border-color)",
                borderRadius: 6,
                color: "var(--text-primary)",
                fontSize: 14,
              }}
            />
            <button className="btn-icon" onClick={doSearch}>
              Go
            </button>
          </div>
          {searchResults.length > 0 && (
            <div style={{ marginTop: 8, maxHeight: 200, overflowY: "auto", fontSize: 13 }}>
              {searchResults.map((r, i) => (
                <div key={i} style={{ padding: "6px 0", borderBottom: "1px solid var(--border-color)" }}>
                  <strong style={{ color: "var(--accent)" }}>{r.chapter || "—"}</strong>
                  <div style={{ color: "var(--text-secondary)" }}>{r.snippet}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="reader-container">
        {!book && !error && (
          <div className="reader-loading">
            <div className="spinner" />
            <p>Loading book...</p>
          </div>
        )}
        <div ref={viewerRef} className={`epub-viewer ${book?.file_type === "epub" ? "" : "hidden"}`} />
        <div id="pdf-container" className={`pdf-container ${book?.file_type === "pdf" ? "" : "hidden"}`} />
      </div>
    </div>
  );
}

export default function ReaderPage() {
  return (
    <Suspense
      fallback={
        <div className="reader-body">
          <div className="reader-loading">
            <div className="spinner" />
            <p>Loading...</p>
          </div>
        </div>
      }
    >
      <ReaderInner />
    </Suspense>
  );
}
