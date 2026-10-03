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
  const [searchResults, setSearchResults] = useState<{ chapter: string | null; snippet: string | null; position: number | null }[]>([]);
  const [searched, setSearched] = useState(false);
  const [pageInfo, setPageInfo] = useState("—");
  const [hasPrev, setHasPrev] = useState(false);
  const [hasNext, setHasNext] = useState(false);
  const [navTick, setNavTick] = useState(0);
  const [tocOpen, setTocOpen] = useState(false);
  const [toc, setToc] = useState<{ label: string; href: string; depth: number; index: number | null }[]>([]);
  const [currentHref, setCurrentHref] = useState<string | null>(null);
  const [typeOpen, setTypeOpen] = useState(false);
  const [fontFamily, setFontFamily] = useState<"serif" | "sans" | "mono">("serif");
  const [lineHeight, setLineHeight] = useState(1.65);
  const [margin, setMargin] = useState(18);
  const [justify, setJustify] = useState(true);

  const viewerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const renditionRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const epubRef = useRef<any>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const percentRef = useRef(0);
  const savingRef = useRef(false);
  const touchStartX = useRef<number | null>(null);

  // Load theme + font size preferences
  useEffect(() => {
    const saved = localStorage.getItem("theme");
    const isDark = saved ? saved === "dark" : true;
    setDark(isDark);
    setFontSize(parseInt(localStorage.getItem("reader-font-size") || "16", 10));
    const fam = localStorage.getItem("reader-font-family");
    if (fam === "serif" || fam === "sans" || fam === "mono") setFontFamily(fam);
    const lh = parseFloat(localStorage.getItem("reader-line-height") || "");
    if (lh >= 1.2 && lh <= 2.4) setLineHeight(lh);
    const mg = parseInt(localStorage.getItem("reader-margin") || "", 10);
    if (!Number.isNaN(mg) && mg >= 0 && mg <= 64) setMargin(mg);
    setJustify(localStorage.getItem("reader-justify") !== "0");
  }, []);

  const FONT_STACKS: Record<string, string> = {
    serif: 'Georgia, "Iowan Old Style", "Times New Roman", serif',
    sans: 'ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif',
    mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  };

  const applyReaderTheme = useCallback((isDark: boolean) => {
    try {
      const themes = renditionRef.current?.themes;
      if (!themes) return;
      const stack = FONT_STACKS[fontFamily] || FONT_STACKS.serif;
      const pad = `${margin}px ${Math.round(margin * 1.6)}px`;
      const align = justify ? "justify" : "left";
      const shared = {
        "html, body": {
          "font-family": `${stack} !important`,
          "line-height": `${lineHeight} !important`,
          padding: `${pad} !important`,
          background: "transparent !important",
        },
        "p, div, span, li, blockquote": {
          "font-family": `${stack} !important`,
          "line-height": `${lineHeight} !important`,
          "text-align": `${align} !important`,
        },
      };
      themes.register("nmlr-dark", {
        ...shared,
        body: { background: "#0e0e12 !important", color: "#d6d4e0 !important" },
        a: { color: "#e0a458 !important" },
      });
      themes.register("nmlr-light", {
        ...shared,
        body: { background: "#faf9f6 !important", color: "#2a2a32 !important" },
        a: { color: "#a5661f !important" },
      });
      themes.select(isDark ? "nmlr-dark" : "nmlr-light");
    } catch {
      // PDF mode — no rendition
    }
  }, [fontFamily, lineHeight, margin, justify]);

  // Re-register epub.js themes whenever typography prefs change.
  useEffect(() => {
    applyReaderTheme(dark);
  }, [applyReaderTheme, dark]);

  const toggleTheme = () => {
    const next = !dark;
    setDark(next);
    document.body.classList.toggle("dark-theme", next);
    localStorage.setItem("theme", next ? "dark" : "light");
    applyReaderTheme(next);
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
          const host = viewerRef.current!;
          // Explicit PIXELS: "100%" makes epub.js cache whatever the container
          // happened to measure mid-layout (race → tiny reader that survives
          // resizes). Measure after layout settles, then ResizeObserver keeps
          // it correct on phone rotation AND desktop window resizes.
          const measure = () => ({
            width: Math.max(200, host.clientWidth || window.innerWidth),
            height: Math.max(200, host.clientHeight || Math.round(window.innerHeight * 0.8)),
          });
          const { width, height } = measure();
          const rendition = epub.renderTo(host, { width, height, flow: "paginated", spread: "none" });
          renditionRef.current = rendition;
          epubRef.current = epub;
          // relocated MUST be registered BEFORE display(): the first relocation
          // fires during display() and enables the footer buttons. Registering
          // after display() resolved is why the page buttons started disabled.
          //
          // NOTE: location.start.percentage is 0 until epub.locations.generate()
          // has run — so it CANNOT be the only percent source. Without the spine
          // fallback below, hasPrev stays false forever ("buttons don't work")
          // and progress never saves ("Currently Reading" always empty).
          rendition.on("relocated", (location: { start: { percentage: number; index?: number; displayed?: { page: number; total: number }; href: string }; end: { percentage: number; displayed?: { page: number; total: number } } }) => {
            if (!location?.start) return;
            const reported = location.start.percentage;
            let pct: number;
            if (Number.isFinite(reported) && reported > 0) {
              pct = reported * 100;
            } else {
              // Fall back to spine position: chapter index plus fraction within
              // the chapter (from its displayed page count).
              const spineLen = epubRef.current?.spine?.length ?? 0;
              const idx = location.start.index ?? 0;
              const frac =
                location.start.displayed && location.start.displayed.total > 0
                  ? (location.start.displayed.page - 1) / location.start.displayed.total
                  : 0;
              pct = spineLen > 0 ? ((idx + frac) / spineLen) * 100 : 0;
            }
            percentRef.current = Math.max(0, Math.min(100, pct));
            const page = location.start.displayed?.page;
            // displayed.total is the real per-section page count; the old code
            // printed end-spread's page number here ("2 / 2" garbage).
            const total = location.start.displayed?.total;
            // "1 / 1" is noise: it is what epub.js reports for the very first
            // render, before locations.generate() has laid the book out, and it
            // makes a phone reader look stuck. Show the percentage until the
            // real page count is known.
            setPageInfo(
              page && total && total > 1 ? `${page} / ${total}` : `${Math.round(percentRef.current)}%`
            );
            setHasPrev(percentRef.current > 0.5);
            setHasNext(percentRef.current < 99.5);
            if (location.start.href) setCurrentHref(location.start.href);
          });
          await rendition.display();
          // Apply the user's theme (may have loaded from localStorage after mount).
          applyReaderTheme(dark);

          // Table of contents for the chapter drawer. Flatten nested nav into
          // one list; depth drives indentation. Runs after first paint so it
          // never delays the opening page.
          try {
            const nav = await epub.loaded.navigation;
            const items: { label: string; href: string; depth: number; index: number | null }[] = [];
            // Nav hrefs are not always byte-identical to the spine's (percent
            // encoding and nav-relative paths both differ between producers),
            // and rendition.display(href) throws "No Section Found" when the
            // lookup misses. Resolve each entry to a SPINE INDEX once, here,
            // where a miss is harmless.
            const resolveIndex = (href: string): number | null => {
              const tries = [href, href.split("#")[0], decodeURIComponent(href.split("#")[0])];
              for (const t of tries) {
                const item = epub.spine?.get?.(t);
                if (item && typeof item.index === "number") return item.index;
              }
              return null;
            };
            const walk = (nodes: unknown, depth: number) => {
              if (!Array.isArray(nodes) || items.length >= 400) return;
              for (const raw of nodes as { label?: string; href?: string; subitems?: unknown }[]) {
                if (items.length >= 400) break;
                if (raw?.href) {
                  items.push({
                    label: (raw.label || "Untitled").trim() || "Untitled",
                    href: raw.href,
                    depth,
                    index: resolveIndex(raw.href),
                  });
                }
                if (raw?.subitems) walk(raw.subitems, depth + 1);
              }
            };
            walk((nav as { toc?: unknown } | null)?.toc, 0);
            if (!cancelled) setToc(items);
          } catch {
            // Books without a usable nav are fine — the drawer just stays empty.
          }

          // Keep the rendition matched to the container: rotation, window
          // resize, toolbar/search panel collapsing in/out.
          const ro = new ResizeObserver(() => {
            const r = renditionRef.current;
            if (!r) return;
            const next = measure();
            try {
              r.resize(next.width, next.height);
            } catch {
              // rendition destroyed mid-flight
            }
          });
          ro.observe(host);
          resizeObserverRef.current = ro;

          // Generate locations so percentages and page numbers become real.
          // Fresh reads do it in the background (the spine fallback above keeps
          // buttons/progress working meanwhile); resumes await it to jump
          // accurately to the saved position.
          const gen = epub.locations
            .generate(1024)
            .then(() => {
              if (cancelled) return;
              try {
                rendition.reportLocation?.();
              } catch {
                // rendition already torn down
              }
            })
            .catch(() => {
              // big/odd books can fail generation — spine fallback still works
            });
          if (initialPercent > 0 && initialPercent < 100) {
            try {
              await gen;
              // Pass the percentage as a 0-1 FLOAT: epubjs converts it with
              // cfiFromPercentage once locations exist. (A locations *index*
              // would be read as a spine index and reject with
              // "No Section Found" — resume silently failing on real books.)
              if (!cancelled) await rendition.display(initialPercent / 100);
            } catch {
              // skip resume silently; reader stays on page 1
            }
          }
        } else {
          // PDF — blob-URL embed in the browser's native viewer.
          const blob = await fileRes.blob();
          const url = URL.createObjectURL(blob);
          const embed = document.createElement("embed");
          embed.src = url;
          embed.type = "application/pdf";
          embed.style.cssText = "width:100%;height:100%;border:none;";
          const container = document.getElementById("pdf-container");
          if (container) container.appendChild(embed);
          setPageInfo("PDF");
          setHasPrev(false);
          setHasNext(false);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load book");
      }
    })();

    return () => {
      cancelled = true;
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      renditionRef.current?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Periodic progress save while reading
  useEffect(() => {
    const interval = setInterval(saveProgress, 30000);
    return () => clearInterval(interval);
  }, [saveProgress]);

  // Reading-session heartbeat: extends the current session every 2 minutes;
  // a final beacon fires on tab close. The server merges heartbeats within
  // a 5-minute window into one session.
  useEffect(() => {
    if (!id) return;
    const beat = () => {
      fetch("/api/stats/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookId: id }),
        keepalive: true,
      }).catch(() => {});
    };
    beat(); // open a session immediately
    const interval = setInterval(beat, 2 * 60 * 1000);
    const onHide = () => {
      if (document.visibilityState === "hidden") beat();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [id]);

  // Keep rendition sized to its container (belt-and-braces for browsers
  // without ResizeObserver; the observer is the primary mechanism now).
  useEffect(() => {
    const onResize = () => {
      const r = renditionRef.current;
      const host = viewerRef.current;
      if (!r || !host) return;
      try {
        r.resize(Math.max(200, host.clientWidth), Math.max(200, host.clientHeight));
      } catch {
        // ignore
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const changeFont = (delta: number) => {
    setFontSize((prev) => {
      const next = Math.max(10, Math.min(28, prev + delta));
      localStorage.setItem("reader-font-size", String(next));
      try {
        renditionRef.current?.themes?.fontSize(`${next}px`);
      } catch {
        // rendition may not exist (PDF mode)
      }
      return next;
    });
  };

  const doSearch = async () => {
    if (!id || searchQuery.trim().length < 2) return;
    try {
      const res = await fetch(`/api/books/${id}/search?q=${encodeURIComponent(searchQuery)}`);
      const data = await res.json();
      setSearchResults(data.results || []);
    } catch {
      setSearchResults([]);
    }
    setSearched(true);
  };

  const goPrev = useCallback(() => {
    renditionRef.current?.prev?.();
    setNavTick((t) => t + 1);
  }, []);

  const goNext = useCallback(() => {
    renditionRef.current?.next?.();
    setNavTick((t) => t + 1);
  }, []);

  // Keyboard navigation (desktop)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key === "ArrowLeft") goPrev();
      if (e.key === "ArrowRight") goNext();
      if (e.key === "Escape") {
        setTocOpen(false);
        setTypeOpen(false);
        setShowSearch(false);
      }
      if ((e.key === "t" || e.key === "T") && !e.metaKey && !e.ctrlKey) setTocOpen((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goPrev, goNext]);

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

  const isEpub = book?.file_type === "epub";

  return (
    <div
      className="reader-body"
      onTouchStart={(e) => {
        touchStartX.current = e.changedTouches[0]?.clientX ?? null;
      }}
      onTouchEnd={(e) => {
        if (touchStartX.current == null || !isEpub) return;
        const dx = (e.changedTouches[0]?.clientX ?? 0) - touchStartX.current;
        if (Math.abs(dx) > 60) (dx < 0 ? goNext : goPrev)();
        touchStartX.current = null;
      }}
    >
      <div className="reader-toolbar">
        <div className="toolbar-left">
          <button className="btn-icon" onClick={() => router.push("/dashboard")} title="Back to Library" aria-label="Back to Library">
            ←
          </button>
          <div className="book-title-bar">{book?.title || "Loading…"}</div>
        </div>
        <div className="toolbar-right">
          <button className="btn-icon" onClick={() => { setShowSearch(!showSearch); setSearched(false); setSearchResults([]); }} title="Search in book" aria-label="Search in book">
            🔍
          </button>
          <button className="btn-icon desk-only" onClick={() => changeFont(-2)} title="Decrease font size" aria-label="Decrease font size">
            A−
          </button>
          <button className="btn-icon desk-only" onClick={() => changeFont(2)} title="Increase font size" aria-label="Increase font size">
            A+
          </button>
          {isEpub && (
            <button className="btn-icon desk-only keep-touch" onClick={() => { setTypeOpen((v) => !v); setTocOpen(false); }} title="Reading type" aria-label="Reading type">
              Aa
            </button>
          )}
          {isEpub && (
            <button
              className={`btn-icon desk-only keep-touch ${tocOpen ? "active" : ""}`}
              onClick={() => { setTocOpen((v) => !v); setTypeOpen(false); }}
              title="Contents (T)"
              aria-label="Contents"
            >
              ☰
            </button>
          )}
          <button className="btn-icon desk-only" onClick={toggleTheme} title="Toggle reading theme" aria-label="Toggle reading theme">
            {dark ? "☀" : "🌙"}
          </button>
          <button className="btn-icon desk-only" onClick={goFullscreen} title="Fullscreen" aria-label="Fullscreen">
            ⛶
          </button>
        </div>
      </div>

      {isEpub && tocOpen && (
        <div className="reader-toc">
          <div className="reader-toc-head">Contents</div>
          <div className="reader-toc-list">
            {toc.length === 0 ? (
              <div className="reader-toc-empty">This book lists no chapters.</div>
            ) : (
              toc.map((c, i) => (
                <button
                  key={i}
                  className={`reader-toc-item ${c.href === currentHref ? "on" : ""}`}
                  style={{ paddingLeft: 12 + Math.min(c.depth, 3) * 14 }}
                  onClick={() => {
                    const target = c.index != null ? c.index : c.href;
                    try {
                      Promise.resolve(renditionRef.current?.display(target)).catch(() => {
                        // Some producers ship nav hrefs that resolve to nothing;
                        // fall back to the raw href once, then give up quietly.
                        if (c.index != null) {
                          Promise.resolve(renditionRef.current?.display(c.href)).catch(() => {});
                        }
                      });
                    } catch {
                      // rendition destroyed mid-flight
                    }
                    setTocOpen(false);
                  }}
                >
                  {c.label}
                </button>
              ))
            )}
          </div>
        </div>
      )}

      {isEpub && typeOpen && (
        <div className="reader-type">
          {(
            [
              ["Typeface", ([["serif", "Serif"], ["sans", "Sans"], ["mono", "Mono"]] as [string, string][]).map(([v, lbl]) => ({
                label: lbl,
                on: fontFamily === v,
                act: () => {
                  setFontFamily(v as "serif" | "sans" | "mono");
                  localStorage.setItem("reader-font-family", v);
                },
              }))],
              ["Leading", ([["Compact", 1.45], ["Book", 1.65], ["Airy", 1.9]] as [string, number][]).map(([lbl, v]) => ({
                label: lbl,
                on: lineHeight === v,
                act: () => {
                  setLineHeight(v);
                  localStorage.setItem("reader-line-height", String(v));
                },
              }))],
              ["Margins", ([["Tight", 8], ["Medium", 18], ["Wide", 32]] as [string, number][]).map(([lbl, v]) => ({
                label: lbl,
                on: margin === v,
                act: () => {
                  setMargin(v);
                  localStorage.setItem("reader-margin", String(v));
                },
              }))],
              ["Justify", [{ label: justify ? "On" : "Off", on: justify, act: () => { setJustify((j) => !j); localStorage.setItem("reader-justify", justify ? "0" : "1"); } }]],
            ] as [string, { label: string; on: boolean; act: () => void }[]][]
          ).map(([group, opts]) => (
            <div key={group} className="rt-row">
              <span className="rt-label">{group}</span>
              <div className="rt-seg">
                {opts.map((o) => (
                  <button key={o.label} className={o.on ? "on" : ""} onClick={o.act}>
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {showSearch && (
        <div className="reader-search">
          <div className="reader-search-row">
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && doSearch()}
              placeholder="Search in this book…"
              autoFocus
            />
            <button className="btn-icon bordered" onClick={doSearch}>
              Go
            </button>
          </div>
          {searchResults.length > 0 ? (
            <div className="reader-search-results">
              {searchResults.map((r, i) => (
                <button
                  key={i}
                  className="reader-search-result"
                  onClick={() => {
                    if (r.position != null) renditionRef.current?.display(r.position);
                    setShowSearch(false);
                  }}
                  title={r.position != null ? "Jump to this chapter" : undefined}
                >
                  <div className="rs-chapter">{r.chapter || "—"}</div>
                  <div className="rs-snippet">{r.snippet}</div>
                </button>
              ))}
            </div>
          ) : searched ? (
            <p className="reader-search-empty">No matches found. (Content search indexes pre-extracted text.)</p>
          ) : null}
        </div>
      )}

      <div className="reader-container">
        {!book && !error && (
          <div className="reader-loading">
            <div className="spinner" />
            <p>Loading book…</p>
          </div>
        )}
        <div ref={viewerRef} className={`epub-viewer ${isEpub ? "" : "hidden"}`} />
        <div id="pdf-container" className={`pdf-container ${book?.file_type === "pdf" ? "" : "hidden"}`} />
      </div>

      {isEpub && (
        <div className="reader-footer" data-tick={navTick}>
          <button className="btn-icon bordered" onClick={goPrev} disabled={!hasPrev} title="Previous page (←)" aria-label="Previous page">
            ‹
          </button>
          <span className="page-info">{pageInfo}</span>
          <button className="btn-icon bordered" onClick={goNext} disabled={!hasNext} title="Next page (→)" aria-label="Next page">
            ›
          </button>
        </div>
      )}
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
            <p>Loading…</p>
          </div>
        </div>
      }
    >
      <ReaderInner />
    </Suspense>
  );
}
