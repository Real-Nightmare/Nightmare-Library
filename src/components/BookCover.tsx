"use client";

import { useState } from "react";
import GeneratedCover from "./GeneratedCover";

interface Props {
  bookId: string;
  coverUrl?: string | null;
  title: string;
  author?: string | null;
  kicker?: string;
}

/**
 * A book's cover, with a graceful path for every "there is no cover" case:
 *
 *  - no `cover_url` at all (PDF, video)  → generated cover straight away
 *  - `cover_url` that 404s                → generated cover, AND we quietly
 *    ask the server to re-extract the art from the stored EPUB once per
 *    session, so old uploads heal themselves instead of showing a broken
 *    image forever.
 *
 * `onError` never surfaces as a console error because we swap the element out
 * before the browser reports it.
 */
export default function BookCover({ bookId, coverUrl, title, author, kicker }: Props) {
  const [broken, setBroken] = useState(false);

  if (!coverUrl || broken) {
    return <GeneratedCover title={title} author={author} kicker={kicker} />;
  }

  return (
    <img
      src={coverUrl}
      alt=""
      loading="lazy"
      onError={() => {
        setBroken(true);
        try {
          const key = `nmlr-cover-retry:${bookId}`;
          if (!sessionStorage.getItem(key)) {
            sessionStorage.setItem(key, "1");
            void fetch(`/api/books/${bookId}/refresh`, { method: "POST" });
          }
        } catch {
          // Private mode / storage disabled — the generated cover still shows.
        }
      }}
    />
  );
}
