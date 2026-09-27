import { mkdir, writeFile, readFile, unlink, stat } from "fs/promises";
import { gunzipSync, gzipSync } from "zlib";
import path from "path";
import { Readable } from "stream";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { resolveSetting } from "./appsettings";

/**
 * Storage layer — multi-provider, settings-driven, transparent gzip.
 *
 * Providers (Settings page, env fallback):
 * - b2         : Backblaze B2 (10GB free) via S3-compatible API
 * - b2_cascade : B2 with automatic failover to a second S3-compatible provider
 * - local      : server disk .data/books/ (zero-config dev/self-host)
 *
 * COMPRESSION: book files (EPUB/PDF) are gzip-compressed CLIENT-SIDE before
 * upload (double-zip: an EPUB is already a zip — gzipping the whole archive
 * again reaps the remaining redundancy, typically 5-15% extra on real books,
 * more on PDFs). Per-file `file_encoding` ('gzip'|'raw') records what is
 * stored, so old uploads keep working and every read decompresses
 * transparently. Video stays raw (incompressible) and streams with HTTP Range.
 */

export type StorageProvider = "b2" | "b2_cascade" | "local";

export interface StoredFile {
  provider: StorageProvider;
  storageId: string;
}

const BOOKS_DIR = path.join(process.cwd(), ".data", "books");

// ---------------- Provider configuration (settings -> env) ----------------

interface S3Config {
  keyId: string;
  appKey: string;
  bucket: string;
  region: string;
  endpoint?: string;
}

async function s3Config(): Promise<S3Config | null> {
  const keyId = await resolveSetting("b2_key_id");
  const appKey = await resolveSetting("b2_application_key");
  const bucket = await resolveSetting("b2_bucket");
  if (!keyId || !appKey || !bucket) return null;
  const region = (await resolveSetting("b2_region")) || "us-east-005";
  return { keyId, appKey, bucket, region };
}

async function cascadeConfig(): Promise<S3Config | null> {
  const endpoint = await resolveSetting("b2_cascade_endpoint");
  const keyId = await resolveSetting("b2_cascade_key_id");
  const appKey = await resolveSetting("b2_cascade_secret");
  const bucket = await resolveSetting("b2_cascade_bucket");
  if (!endpoint || !keyId || !appKey || !bucket) return null;
  const region = (await resolveSetting("b2_cascade_region")) || "us-east-1";
  return { keyId, appKey, bucket, region, endpoint };
}

function clientFor(cfg: S3Config): S3Client {
  return new S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint ?? `https://s3.${cfg.region}.backblazeb2.com`,
    credentials: { accessKeyId: cfg.keyId, secretAccessKey: cfg.appKey },
  });
}

/** Which provider new uploads go to (settings override, else auto-detect). */
export async function activeStorageProvider(): Promise<StorageProvider> {
  const { resolveStorageProvider } = await import("./appsettings");
  const p = await resolveStorageProvider();
  return p === "b2_cascade" ? "b2" : p; // cascade is a read/failover partner; uploads still target B2
}

// ---------------- Compression helpers ----------------

export interface CompressionResult {
  data: Buffer;
  encoding: "gzip" | "raw";
  originalSize: number;
}

/** Try gzip; keep whichever is smaller (gains must clear a 3% threshold). */
export function tryCompress(data: Buffer): CompressionResult {
  if (data.byteLength < 512) return { data, encoding: "raw", originalSize: data.byteLength };
  try {
    const compressed = gzipSync(data, { level: 9 });
    if (compressed.byteLength < data.byteLength * 0.97) {
      return { data: compressed, encoding: "gzip", originalSize: data.byteLength };
    }
  } catch {
    // fall through to raw
  }
  return { data, encoding: "raw", originalSize: data.byteLength };
}

/** Decompress when the stored object is gzip-encoded. */
export function tryDecompress(data: Buffer, encoding: string | null | undefined): Buffer {
  if (encoding === "gzip") {
    try {
      return gunzipSync(data);
    } catch (error) {
      console.error("gunzip failed — serving raw bytes:", error);
    }
  }
  return data;
}

// ---------------- Uploads ----------------

export function bookObjectKey(bookId: string, fileType: string): string {
  return `books/${bookId}.${fileType}`;
}

/** Presigned PUT for the browser to upload directly to B2. */
export async function createPresignedUpload(
  bookId: string,
  fileType: string,
  contentType: string
): Promise<{ uploadUrl: string; storageId: string; provider: StorageProvider } | null> {
  const cfg = await s3Config();
  if (!cfg) return null;
  const key = bookObjectKey(bookId, fileType);
  const command = new PutObjectCommand({ Bucket: cfg.bucket, Key: key, ContentType: contentType });
  const uploadUrl = await getSignedUrl(clientFor(cfg), command, { expiresIn: 900 });
  return { uploadUrl, storageId: key, provider: "b2" };
}

/** Verifies a file landed in B2 after a presigned upload (stored/compressed size). */
export async function verifyUpload(storageId: string): Promise<number | null> {
  const cfg = await s3Config();
  if (!cfg) return null;
  try {
    const res = await clientFor(cfg).send(
      new HeadObjectCommand({ Bucket: cfg.bucket, Key: storageId })
    );
    return res.ContentLength ?? null;
  } catch {
    return null;
  }
}

/** Server-side save for the local provider (writes the payload as-is). */
export async function saveBookFile(
  bookId: string,
  fileType: string,
  payload: Buffer
): Promise<StoredFile> {
  const filename = `${bookId}.${fileType}`;
  await mkdir(BOOKS_DIR, { recursive: true });
  await writeFile(path.join(BOOKS_DIR, filename), payload);
  return { provider: "local", storageId: filename };
}

// ---------------- Reads (with transparent decompression) ----------------

/**
 * Read a book file and decode it to its ORIGINAL bytes. Books are loaded
 * fully into memory by the reader anyway, so a Buffer is the natural shape.
 * B2 reads fail over to the cascade provider when configured.
 */
export async function readBookFileDecoded(
  provider: string | null | undefined,
  storageId: string,
  encoding: string | null | undefined
): Promise<Buffer | null> {
  try {
    if (provider === "b2" || provider === "b2_cascade") {
      const primary = await s3Config();
      const secondary = await cascadeConfig();
      try {
        if (!primary) return null;
        const res = await clientFor(primary).send(
          new GetObjectCommand({ Bucket: primary.bucket, Key: storageId })
        );
        return tryDecompress(await streamToBuffer(res.Body), encoding);
      } catch (err) {
        if (!secondary) throw err;
        const res = await clientFor(secondary).send(
          new GetObjectCommand({ Bucket: secondary.bucket, Key: storageId })
        );
        return tryDecompress(await streamToBuffer(res.Body), encoding);
      }
    }
    const filePath = path.join(BOOKS_DIR, path.basename(storageId));
    return tryDecompress(await readFile(filePath), encoding);
  } catch (error) {
    console.error("readBookFileDecoded failed:", error);
    return null;
  }
}

// ---------------- Deletes ----------------

export async function deleteBookFile(
  provider: string | null | undefined,
  storageId: string
): Promise<void> {
  try {
    if (provider === "b2" || provider === "b2_cascade") {
      const primary = await s3Config();
      const secondary = await cascadeConfig();
      // The object may live on either side — try both, ignore misses.
      if (primary) {
        try {
          await clientFor(primary).send(
            new DeleteObjectCommand({ Bucket: primary.bucket, Key: storageId })
          );
        } catch {
          // ignore
        }
      }
      if (secondary) {
        try {
          await clientFor(secondary).send(
            new DeleteObjectCommand({ Bucket: secondary.bucket, Key: storageId })
          );
        } catch {
          // ignore
        }
      }
      return;
    }
    await unlink(path.join(BOOKS_DIR, path.basename(storageId)));
  } catch {
    // already gone — fine
  }
}

// ---------------- Media streaming (video, HTTP Range) ----------------

export interface MediaRange {
  stream: Readable;
  size: number | null;
  /** 200 for full content, 206 when serving a byte range. */
  status: 200 | 206;
  start: number;
  end: number;
}

function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") {
    const len = Number(m[2]);
    if (len === 0 || size === 0) return null;
    return { start: Math.max(0, size - len), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (size === 0 || start > end || start >= size) return null;
  return { start, end };
}

function rangeResult(
  body: Readable,
  size: number | null,
  rangeHeader: string | null
): MediaRange {
  const range = parseRange(rangeHeader, size ?? 0);
  return {
    stream: body,
    size,
    status: range && rangeHeader ? 206 : 200,
    start: range?.start ?? 0,
    end: range?.end ?? Math.max(0, (size ?? 1) - 1),
  };
}

/**
 * Stream media with HTTP Range support — required for <video> seeking.
 * Video is stored raw; no decompression on this path.
 */
export async function openMediaStream(
  provider: string | null | undefined,
  storageId: string,
  rangeHeader: string | null
): Promise<MediaRange | null> {
  try {
    if (provider === "b2" || provider === "b2_cascade") {
      const primary = await s3Config();
      const secondary = await cascadeConfig();
      try {
        if (!primary) return null;
        const res = await clientFor(primary).send(
          new GetObjectCommand({
            Bucket: primary.bucket,
            Key: storageId,
            ...(rangeHeader ? { Range: rangeHeader } : {}),
          })
        );
        return rangeResult(res.Body as Readable, res.ContentLength ?? null, rangeHeader);
      } catch (err) {
        if (!secondary) throw err;
        const res = await clientFor(secondary).send(
          new GetObjectCommand({
            Bucket: secondary.bucket,
            Key: storageId,
            ...(rangeHeader ? { Range: rangeHeader } : {}),
          })
        );
        return rangeResult(res.Body as Readable, res.ContentLength ?? null, rangeHeader);
      }
    }

    const filePath = path.join(BOOKS_DIR, path.basename(storageId));
    const info = await stat(filePath);
    const range = parseRange(rangeHeader, info.size);
    const fs = await import("fs");
    if (range) {
      const stream = fs.createReadStream(filePath, { start: range.start, end: range.end }) as Readable;
      return { stream, size: info.size, status: 206, start: range.start, end: range.end };
    }
    const stream = fs.createReadStream(filePath) as Readable;
    return { stream, size: info.size, status: 200, start: 0, end: info.size - 1 };
  } catch (error) {
    console.error("openMediaStream failed:", error);
    return null;
  }
}

async function streamToBuffer(stream: unknown): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const s = stream as AsyncIterable<Uint8Array>;
  for await (const chunk of s) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
