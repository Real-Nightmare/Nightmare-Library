import JSZip from "jszip";

/**
 * EPUB metadata + structure extraction, from raw EPUB bytes.
 *
 * Every EPUB already carries its own title, author, publisher, language and
 * spine length in the OPF package document. The library was asking the person
 * uploading to retype all of that (and often didn't), which is why shelves
 * ended up full of "vol1" / "Unknown hand". This module reads the truth out
 * of the file itself so uploads, backfills and the reader all agree.
 *
 * Parsing is deliberately regex-based rather than DOM-based: OPF is XML with
 * wildly inconsistent attribute order, namespaces and dc: prefix binding, and
 * a hand-rolled scan survives all of that without a parser dependency.
 */

export interface EpubMeta {
  title: string | null;
  author: string | null;
  publisher: string | null;
  language: string | null;
  description: string | null;
  /** Spine entries — the chapter count used by the reader's TOC. */
  chapters: number;
  /** Reading-time estimate at ~230 words/min. */
  wordCount: number;
}

/** Collapse XML whitespace, decode entities and strip tags — no length cap. */
function strip(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Same, but for a metadata VALUE: capped so a 40KB <dc:description> can't
 *  bloat a database row or a list response. */
function clean(value: string | undefined | null): string | null {
  if (!value) return null;
  const text = strip(value);
  return text.length ? text.slice(0, 500) : null;
}

/** First non-empty match across a list of regexes. */
function pick(xml: string, patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const hit = clean(re.exec(xml)?.[1]);
    if (hit) return hit;
  }
  return null;
}

/** Locate the OPF package document inside a zip. */
async function findOpf(zip: JSZip): Promise<{ opf: string; baseDir: string } | null> {
  const container = zip.file("META-INF/container.xml");
  let opfPath: string | null = null;
  if (container) {
    const xml = await container.async("string");
    opfPath = /full-path=["']([^"']+\.opf)["']/i.exec(xml)?.[1] ?? null;
  }
  if (!opfPath) {
    // Fall back to any .opf in the archive (some producers ship a broken
    // container.xml but the package document is right there).
    const name = Object.keys(zip.files).find((f) => f.toLowerCase().endsWith(".opf"));
    opfPath = name ?? null;
  }
  if (!opfPath) return null;
  const decoded = decodeURIComponent(opfPath);
  const file = zip.file(decoded) ?? zip.file(opfPath);
  if (!file) return null;
  return {
    opf: await file.async("string"),
    baseDir: decoded.includes("/") ? decoded.slice(0, decoded.lastIndexOf("/") + 1) : "",
  };
}

/** Read Dublin Core / calibre metadata + spine length out of an EPUB. */
export async function extractEpubMeta(epub: Buffer): Promise<EpubMeta | null> {
  const empty: EpubMeta = {
    title: null,
    author: null,
    publisher: null,
    language: null,
    description: null,
    chapters: 0,
    wordCount: 0,
  };
  try {
    const zip = await JSZip.loadAsync(epub);
    const found = await findOpf(zip);
    if (!found) return empty;
    const xml = found.opf;

    // dc:* first (the standard), then the <meta name="calibre:…"> convention
    // that most Western EPUB producers actually use.
    const title = pick(xml, [
      /<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i,
      /<meta[^>]*name=["']calibre:title["'][^>]*content=["']([^"']*)["']/i,
      /<meta[^>]*content=["']([^"']*)["'][^>]*name=["']calibre:title["']/i,
    ]);
    const author = pick(xml, [
      /<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i,
      /<meta[^>]*name=["']calibre:author["'][^>]*content=["']([^"']*)["']/i,
      /<meta[^>]*content=["']([^"']*)["'][^>]*name=["']calibre:author["']/i,
    ]);

    // Spine = the reader's chapter count.
    const spineBlock = /<spine\b[^>]*>([\s\S]*?)<\/spine>/i.exec(xml)?.[1] ?? "";
    const chapters = (spineBlock.match(/<itemref\b/gi) || []).length;

    // Word count across the spine documents, capped so a 14MB LN stays quick.
    let wordCount = 0;
    const hrefs = new Set<string>();
    for (const m of xml.matchAll(/<item\b[^>]*>/gi)) {
      const tag = m[0];
      const href = /href=["']([^"']+)["']/i.exec(tag)?.[1];
      const type = /media-type=["']([^"']+)["']/i.exec(tag)?.[1] ?? "";
      if (href && /xhtml|html/i.test(type)) hrefs.add(href);
    }
    for (const href of hrefs) {
      if (wordCount > 600_000) break;
      const doc = zip.file(decodeURIComponent(found.baseDir + href)) ?? zip.file(href);
      if (!doc) continue;
      const text = strip(await doc.async("string"));
      wordCount += text.split(/\s+/).filter(Boolean).length;
    }

    return {
      title,
      author,
      publisher: pick(xml, [
        /<dc:publisher[^>]*>([\s\S]*?)<\/dc:publisher>/i,
        /<meta[^>]*name=["']calibre:publisher["'][^>]*content=["']([^"']*)["']/i,
      ]),
      language: pick(xml, [/<dc:language[^>]*>([\s\S]*?)<\/dc:language>/i]),
      description: pick(xml, [/<dc:description[^>]*>([\s\S]*?)<\/dc:description>/i]),
      chapters,
      wordCount,
    };
  } catch (error) {
    console.error("extractEpubMeta failed (non-fatal):", error);
    return null;
  }
}

/**
 * Minutes needed to read a book, from its own word count.
 * 230 wpm is a comfortable pace for prose; manga pages count as images so the
 * estimate stays honest for them too.
 */
export function readingMinutes(wordCount: number): number {
  return Math.max(1, Math.round(wordCount / 230));
}

/**
 * True when a title looks like it came from a filename rather than a person.
 *
 * Browsers only know `vol3_chapter1.epub`, so an upload that carries the raw
 * filename as its title is a candidate for replacement with the EPUB's own
 * dc:title. Deliberately conservative — a real title ("It", "Dune", "1984")
 * must never be discarded.
 */
export function looksLikeFilenameTitle(title: string | null | undefined): boolean {
  const t = (title || "").trim();
  if (!t) return true;
  if (/^(vol|volume|book|part|chapter|chap|epub|novel|manga|light novel|ln)[\s._-]*\d+\s*$/i.test(t)) return true;
  // Bare short numbers: "1", "12", "03" — but NOT "1984" or "2001", which are
  // far more likely to be a real title than a filename.
  if (/^\d{1,2}$/.test(t)) return true;
  // Filename debris: underscores, dots, doubled spaces
  if (/[_.]/.test(t) || /\s{2,}/.test(t)) return true;
  if (/^(untitled|new document|no title|book|manga|light novel)$/i.test(t)) return true;
  return false;
}
