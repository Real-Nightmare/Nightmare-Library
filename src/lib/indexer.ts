/**
 * EPUB content indexing for in-book search.
 *
 * Called at upload time (both upload paths) with the ORIGINAL epub bytes.
 * Walks the spine, extracts readable text per chapter, and stores
 * (chapter title, href, snippet, full text, position) rows in
 * book_content_index. Pure JS via JSZip (already a dependency).
 *
 * BEST-EFFORT by design: indexing must never fail an upload, so every
 * error is swallowed and reported as false.
 */

interface IndexedChapter {
  href: string;
  chapter: string;
  content_text: string;
  snippet: string;
  position: number;
}

// The XML entities every XHTML file uses, plus numeric forms we handle.
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function htmlToText(html: string): string {
  return decodeXmlEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<\/(p|div|section|article|blockquote|h[1-6]|li|tr|figcaption|pre)>/gi, "\n\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Index an EPUB's chapters into `book_content_index` via the provided insert
 * callback. Returns the number of chapters indexed (0 when nothing found).
 */
export async function indexEpubContent(
  epub: Buffer,
  insertChapter: (row: IndexedChapter) => Promise<void>
): Promise<number> {
  try {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(epub);

    const containerFile = zip.file("META-INF/container.xml");
    if (!containerFile) return 0;
    const containerXml = await containerFile.async("string");
    const opfPath =
      /full-path="([^"]+\.opf)"/i.exec(containerXml)?.[1] ||
      /full-path='([^']+\.opf)'/i.exec(containerXml)?.[1];
    if (!opfPath) return 0;
    const opfFile = zip.file(decodeURIComponent(opfPath));
    if (!opfFile) return 0;
    const opf = await opfFile.async("string");
    const baseDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";

    // Manifest items: id → href (attribute order agnostic).
    const attr = (tag: string, name: string): string | null =>
      new RegExp(`${name}="([^"]+)"`, "i").exec(tag)?.[1] ?? null;
    const manifest = new Map<string, string>();
    for (const m of opf.matchAll(/<item\b[^>]*>/gi)) {
      const id = attr(m[0], "id");
      const href = attr(m[0], "href");
      if (id && href) manifest.set(id, href);
    }

    // Spine order → reading order.
    const spineIds: string[] = [];
    for (const m of opf.matchAll(/<itemref\b[^>]*>/gi)) {
      const idref = attr(m[0], "idref");
      if (idref) spineIds.push(idref);
    }

    let position = 0;
    for (const idref of spineIds.slice(0, 300)) {
      const href = manifest.get(idref);
      if (!href) continue;
      const file = zip.file(decodeURIComponent(baseDir + href)) || zip.file(decodeURIComponent(href));
      if (!file) continue;
      try {
        const html = await file.async("string");
        const text = htmlToText(html);
        if (text.length < 40) continue; // cover pages, toc stubs, etc.
        const title = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(html)?.[1];
        const chapterTitle = title ? htmlToText(title).slice(0, 120) : href.split("/").pop() || href;
        const snippet = text.slice(0, 220);
        await insertChapter({
          href,
          chapter: chapterTitle,
          content_text: text.slice(0, 200_000), // hard cap per chapter
          snippet,
          position: position++,
        });
      } catch {
        // chapter skipped — indexing is best-effort
      }
    }
    return position;
  } catch (error) {
    console.error("indexEpubContent failed (non-fatal):", error);
    return 0;
  }
}
