import { mkdir, writeFile, readFile, unlink } from "fs/promises";
import path from "path";

/**
 * Cover-art extraction for the library grid.
 *
 * - EPUB: locates the cover via META-INF/container.xml → OPF manifest
 *   (item with properties="cover-image", else meta[name=cover] content id,
 *   else first image item), then extracts the bytes. Pure JS via JSZip
 *   (already a transitive dependency of epubjs).
 * - PDF: not extracted (would require the native canvas package) — the grid
 *   falls back to the file-type placeholder.
 *
 * Covers are written to .data/covers/ at upload time (the file bytes are
 * available then) and served from there, keeping the grid fast with no
 * per-cover object-storage round-trip.
 */

const COVERS_DIR = path.join(process.cwd(), ".data", "covers");

export interface ExtractedCover {
  data: Buffer;
  contentType: string;
}

export async function saveCover(bookId: string, cover: ExtractedCover): Promise<void> {
  try {
    await mkdir(COVERS_DIR, { recursive: true });
    await writeFile(path.join(COVERS_DIR, `${bookId}.img`), cover.data);
  } catch (error) {
    console.error("saveCover failed (non-fatal):", error);
  }
}

export async function readCover(bookId: string): Promise<Buffer | null> {
  try {
    return await readFile(path.join(COVERS_DIR, `${bookId}.img`));
  } catch {
    return null;
  }
}

export async function deleteCover(bookId: string): Promise<void> {
  try {
    await unlink(path.join(COVERS_DIR, `${bookId}.img`));
  } catch {
    // already gone
  }
}

/** Locate + extract the EPUB cover. Never throws. */
export async function extractEpubCover(epub: Buffer): Promise<ExtractedCover | null> {
  try {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(epub);

    // 1. container.xml → OPF path
    const containerFile = zip.file("META-INF/container.xml");
    if (!containerFile) return null;
    const containerXml = await containerFile.async("string");
    const opfPath =
      /full-path="([^"]+\.opf)"/i.exec(containerXml)?.[1] ||
      /full-path='([^']+\.opf)'/i.exec(containerXml)?.[1];
    if (!opfPath) return null;
    const opfFile = zip.file(decodeURIComponent(opfPath));
    if (!opfFile) return null;
    const opf = await opfFile.async("string");
    const baseDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";

    // Parse every manifest <item> into { id, href, properties, type }.
    // Attribute ORDER varies wildly between EPUB producers, so capture the
    // whole element first and pick attributes out of it individually.
    const attr = (tag: string, name: string): string | null =>
      new RegExp(`${name}="([^"]+)"`, "i").exec(tag)?.[1] ?? null;

    const items: { id: string | null; href: string | null; properties: string | null; type: string | null }[] = [];
    for (const m of opf.matchAll(/<item\b[^>]*>/gi)) {
      const tag = m[0];
      items.push({
        id: attr(tag, "id"),
        href: attr(tag, "href"),
        properties: attr(tag, "properties"),
        type: attr(tag, "media-type"),
      });
    }

    const candidates: string[] = [];
    // Preference 1: properties contains cover-image (EPUB 3, any attr order)
    const propItem = items.find((it) => it.properties && /cover-image/i.test(it.properties));
    if (propItem?.href) candidates.push(propItem.href);

    // Preference 2: legacy <meta name="cover" content="id"> → item by id
    const metaId = /<meta\b[^>]*name="cover"[^>]*content="([^"]+)"/i.exec(opf)?.[1];
    if (metaId) {
      const byId = items.find((it) => it.id === metaId);
      if (byId?.href) candidates.push(byId.href);
    }

    // Preference 3: first image item in the manifest
    const imgItem = items.find((it) => it.type && /^image\/(jpeg|png|webp)$/i.test(it.type));
    if (imgItem?.href) candidates.push(imgItem.href);

    for (const href of candidates) {
      const file =
        zip.file(decodeURIComponent(baseDir + href)) || zip.file(decodeURIComponent(href));
      if (!file) continue;
      const data = Buffer.from(await file.async("arraybuffer"));
      if (data.byteLength < 500) continue; // tiny icon, not a real cover
      const lower = href.toLowerCase();
      const contentType = lower.endsWith(".png")
        ? "image/png"
        : lower.endsWith(".webp")
          ? "image/webp"
          : "image/jpeg";
      return { data, contentType };
    }
    return null;
  } catch (error) {
    console.error("extractEpubCover failed (non-fatal):", error);
    return null;
  }
}

/** Dispatch by file type. Never throws. PDFs return null (placeholder in UI). */
export async function extractCover(fileType: string, data: Buffer): Promise<ExtractedCover | null> {
  try {
    if (fileType === "epub") return await extractEpubCover(data);
    return null;
  } catch {
    return null;
  }
}
