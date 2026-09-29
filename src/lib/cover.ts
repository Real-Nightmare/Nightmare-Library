import { mkdir, writeFile, readFile, unlink } from "fs/promises";
import path from "path";

/**
 * Cover-art extraction + storage for the library grid.
 *
 * - EPUB: locates the cover via META-INF/container.xml → OPF manifest
 *   (item with properties="cover-image", else meta[name=cover] content id,
 *   else first image item), then extracts the bytes. Pure JS via JSZip
 *   (already a transitive dependency of epubjs).
 * - PDF: not extracted (would require the native canvas package) — the grid
 *   falls back to the file-type placeholder.
 *
 * STORAGE: B2 first (key `covers/<bookId>.img`), local disk fallback when
 * B2 is not configured. The serverless filesystem is ephemeral, so B2 is
 * required for covers to survive across instances in production.
 */

const COVERS_DIR = path.join(process.cwd(), ".data", "covers");

export interface ExtractedCover {
  data: Buffer;
  contentType: string;
}

export async function saveCover(bookId: string, cover: ExtractedCover): Promise<void> {
  try {
    const { putSmallObject } = await import("./storage");
    const key = await putSmallObject(`covers/${bookId}.img`, cover.data, cover.contentType);
    if (key) return; // stored in B2
    // Fallback: local disk (dev / local-storage deployments)
    await mkdir(COVERS_DIR, { recursive: true });
    await writeFile(path.join(COVERS_DIR, `${bookId}.img`), cover.data);
  } catch (error) {
    console.error("saveCover failed (non-fatal):", error);
  }
}

export async function readCover(bookId: string): Promise<Buffer | null> {
  try {
    const { getSmallObject } = await import("./storage");
    const remote = await getSmallObject(`covers/${bookId}.img`);
    if (remote) return remote;
  } catch {
    // fall through to disk
  }
  try {
    return await readFile(path.join(COVERS_DIR, `${bookId}.img`));
  } catch {
    return null;
  }
}

export async function deleteCover(bookId: string): Promise<void> {
  try {
    const { deleteSmallObject } = await import("./storage");
    await deleteSmallObject(`covers/${bookId}.img`);
  } catch {
    // best-effort
  }
  try {
    await unlink(path.join(COVERS_DIR, `${bookId}.img`));
  } catch {
    // already gone
  }
}

/** Sniff image type from magic bytes — EPUB manifests often mislabel images. */
export function detectImageType(data: Buffer): string {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return "image/png";
  if (data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (data.length >= 6 && data.subarray(0, 3).toString("ascii") === "GIF") return "image/gif";
  return "image/jpeg";
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
      return { data, contentType: detectImageType(data) };
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
