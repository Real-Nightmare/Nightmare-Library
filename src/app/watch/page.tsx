"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface Book {
  id: string;
  title: string;
  author: string | null;
  file_type: string;
  media_type: string;
}

export default function WatchPage() {
  const router = useRouter();
  const [book, setBook] = useState<Book | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("id");
    if (!id) {
      router.push("/dashboard");
      return;
    }
    fetch(`/api/books/${id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.book) setBook(d.book);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [router]);

  const videoSrc = book ? `/api/books/${book.id}/media` : null;

  if (loading) {
    return (
      <div className="watch-body">
        <div className="reader-loading">
          <div className="spinner" />
          <p>Loading…</p>
        </div>
      </div>
    );
  }

  if (!book) {
    return (
      <div className="watch-body">
        <div className="reader-loading">
          <p>Media not found.</p>
          <button className="btn-primary" onClick={() => router.push("/dashboard")}>
            Back to library
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="watch-body">
      <nav className="reader-toolbar">
        <div className="toolbar-left">
          <button className="btn-icon" onClick={() => router.push("/dashboard")} title="Back" aria-label="Back">
            ←
          </button>
          <span className="book-title-bar">{book.title}</span>
          <span className="media-chip media-anime_official">Official</span>
        </div>
      </nav>

      <div className="watch-layout">
        <div className="watch-main">
          <div className="watch-player">
            {videoSrc ? (
              <video src={videoSrc} controls autoPlay className="watch-video" />
            ) : (
              <div className="watch-placeholder">
                <h3>No video yet</h3>
                <p>Video file is missing from storage.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
