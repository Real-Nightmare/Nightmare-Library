import { mkdir, writeFile, readFile, unlink, stat } from "fs/promises";
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

/**
 * Storage layer for book files — three backends, picked automatically:
 *
 * 1. Backblaze B2 (production, when B2_KEY_ID + B2_APPLICATION_KEY set)
 *    10GB free, no credit card. S3-compatible via AWS SDK.
 *    - Uploads use PRESIGNED URLS: the browser PUTs the file straight to B2,
 *      bypassing serverless request-body limits (Vercel caps bodies ~4.5MB;
 *      books are 10–200MB).
 *    - Downloads stream from B2 (no full-file buffering).
 *    - Optional B2_CASCADE_* → second S3-compatible provider fallback.
 *
 * 2. Uploadthing (when UPLOADTHING_SECRET + UPLOADTHING_APP_ID set)
 *    2GB free. Server-side save falls back to local disk (direct browser
 *    uploads for UT are not wired in this app).
 *
 * 3. Local disk (default) — `.data/books/`, zero-config for dev/self-host.
 *
 * Books table records which provider + storage_id per file, so all backends
 * can coexist.
 */

export type StorageProvider = "b2" | "uploadthing" | "local";

export interface StoredFile {
  provider: StorageProvider;
  storageId: string; // local: filename; b2: object key; uploadthing: file key
}

const BOOKS_DIR = path.join(process.cwd(), ".data", "books");

const isB2Configured = () =>
  Boolean(process.env.B2_KEY_ID && process.env.B2_APPLICATION_KEY && process.env.B2_BUCKET_NAME);
const isUploadthingConfigured = () =>
  Boolean(process.env.UPLOADTHING_SECRET && process.env.UPLOADTHING_APP_ID);

export function activeStorageProvider(): StorageProvider {
  if (isB2Configured()) return "b2";
  if (isUploadthingConfigured()) return "uploadthing";
  return "local";
}

// ============ S3-compatible (Backblaze B2 + optional cascade) ============

interface S3Target {
  client: S3Client;
  bucket: string;
}

function primaryTarget(): S3Target {
  const region = process.env.B2_REGION || "us-east-005";
  return {
    client: new S3Client({
      region,
      endpoint: `https://s3.${region}.backblazeb2.com`,
      credentials: {
        accessKeyId: process.env.B2_KEY_ID!,
        secretAccessKey: process.env.B2_APPLICATION_KEY!,
      },
    }),
    bucket: process.env.B2_BUCKET_NAME!,
  };
}

function secondaryTarget(): S3Target | null {
  if (!(process.env.B2_CASCADE_ENDPOINT && process.env.B2_CASCADE_KEY_ID && process.env.B2_CASCADE_SECRET && process.env.B2_CASCADE_BUCKET)) {
    return null;
  }
  return {
    client: new S3Client({
      endpoint: process.env.B2_CASCADE_ENDPOINT,
      credentials: {
        accessKeyId: process.env.B2_CASCADE_KEY_ID,
        secretAccessKey: process.env.B2_CASCADE_SECRET,
      },
      region: process.env.B2_CASCADE_REGION || "us-east-1",
    }),
    bucket: process.env.B2_CASCADE_BUCKET,
  };
}

export function bookObjectKey(bookId: string, fileType: string): string {
  return `books/${bookId}.${fileType}`;
}

async function streamToBuffer(stream: unknown): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const s = stream as AsyncIterable<Uint8Array>;
  for await (const chunk of s) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

// ============ Presigned direct uploads (bypasses body-size limits) ============

/**
 * Creates a presigned PUT URL the browser can upload to directly.
 * Returns the storageId (object key) the client must send back to confirm.
 */
export async function createPresignedUpload(
  bookId: string,
  fileType: string,
  contentType: string
): Promise<{ uploadUrl: string; storageId: string; provider: StorageProvider } | null> {
  const key = bookObjectKey(bookId, fileType);

  if (isB2Configured()) {
    const target = primaryTarget();
    const command = new PutObjectCommand({
      Bucket: target.bucket,
      Key: key,
      ContentType: contentType,
    });
    // 15 minutes is plenty for a 200MB upload; short window = less abuse surface
    const uploadUrl = await getSignedUrl(target.client, command, { expiresIn: 900 });
    return { uploadUrl, storageId: key, provider: "b2" };
  }

  return null; // caller falls back to server-side (local disk) upload
}

/** Verifies a file actually landed in B2 after a presigned upload. */
export async function verifyUpload(storageId: string): Promise<number | null> {
  if (!isB2Configured()) return null;
  const target = primaryTarget();
  try {
    const res = await target.client.send(
      new HeadObjectCommand({ Bucket: target.bucket, Key: storageId })
    );
    return res.ContentLength ?? null;
  } catch {
    return null;
  }
}

// ============ Server-side save (local dev / fallback) ============

export async function saveBookFile(
  bookId: string,
  fileType: string,
  data: Buffer,
  contentType: string
): Promise<StoredFile> {
  const filename = `${bookId}.${fileType}`;
  await mkdir(BOOKS_DIR, { recursive: true });
  await writeFile(path.join(BOOKS_DIR, filename), data);
  return { provider: "local", storageId: filename };
}

// ============ Reads ============

/**
 * Returns a readable stream of the book file.
 * For B2, streams straight from the object store (no full buffering).
 * For local, streams from disk.
 */
export async function openBookStream(
  provider: string | null | undefined,
  storageId: string
): Promise<{ stream: Readable; size: number | null } | null> {
  try {
    if (provider === "b2" && isB2Configured()) {
      const target = primaryTarget();
      try {
        const res = await target.client.send(
          new GetObjectCommand({ Bucket: target.bucket, Key: storageId })
        );
        const body = res.Body as Readable;
        return { stream: body, size: res.ContentLength ?? null };
      } catch (err) {
        const secondary = secondaryTarget();
        if (!secondary) throw err;
        const res = await secondary.client.send(
          new GetObjectCommand({ Bucket: secondary.bucket, Key: storageId })
        );
        return { stream: res.Body as Readable, size: res.ContentLength ?? null };
      }
    }

    const filePath = path.join(BOOKS_DIR, path.basename(storageId));
    const info = await stat(filePath);
    const stream = (await import("fs")).createReadStream(filePath) as Readable;
    return { stream, size: info.size };
  } catch (error) {
    console.error("openBookStream failed:", error);
    return null;
  }
}

/** Whole-file read (kept for small-file use cases like cover art). */
export async function readBookFile(
  provider: string | null | undefined,
  storageId: string
): Promise<Buffer | null> {
  try {
    if (provider === "b2" && isB2Configured()) {
      const target = primaryTarget();
      try {
        const res = await target.client.send(
          new GetObjectCommand({ Bucket: target.bucket, Key: storageId })
        );
        return await streamToBuffer(res.Body);
      } catch (err) {
        const secondary = secondaryTarget();
        if (!secondary) throw err;
        const res = await secondary.client.send(
          new GetObjectCommand({ Bucket: secondary.bucket, Key: storageId })
        );
        return await streamToBuffer(res.Body);
      }
    }
    return await readFile(path.join(BOOKS_DIR, path.basename(storageId)));
  } catch (error) {
    console.error("readBookFile failed:", error);
    return null;
  }
}

// ============ Deletes ============

export async function deleteBookFile(
  provider: string | null | undefined,
  storageId: string
): Promise<void> {
  try {
    if (provider === "b2" && isB2Configured()) {
      const target = primaryTarget();
      try {
        await target.client.send(new DeleteObjectCommand({ Bucket: target.bucket, Key: storageId }));
      } catch {
        const secondary = secondaryTarget();
        if (secondary) {
          await secondary.client.send(
            new DeleteObjectCommand({ Bucket: secondary.bucket, Key: storageId })
          );
        }
      }
      return;
    }
    await unlink(path.join(BOOKS_DIR, path.basename(storageId)));
  } catch {
    // already gone — fine
  }
}

// ============ Media streaming (HTTP Range) ============

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
    // suffix range: last N bytes
    const len = Number(m[2]);
    if (len === 0 || size === 0) return null;
    return { start: Math.max(0, size - len), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (size === 0 || start > end || start >= size) return null;
  return { start, end };
}

/**
 * Stream media with HTTP Range support — required for <video> seeking on MP4s.
 * B2 path forwards the Range header upstream; local path slices the file stream.
 */
export async function openMediaStream(
  provider: string | null | undefined,
  storageId: string,
  rangeHeader: string | null
): Promise<MediaRange | null> {
  try {
    if (provider === "b2" && isB2Configured()) {
      const target = primaryTarget();
      try {
        const res = await target.client.send(
          new GetObjectCommand({
            Bucket: target.bucket,
            Key: storageId,
            ...(rangeHeader ? { Range: rangeHeader } : {}),
          })
        );
        const size = res.ContentLength ?? null;
        const range = parseRange(rangeHeader, size ?? 0);
        return {
          stream: res.Body as Readable,
          size,
          status: range && rangeHeader ? 206 : 200,
          start: range?.start ?? 0,
          end: range?.end ?? Math.max(0, (size ?? 1) - 1),
        };
      } catch (err) {
        const secondary = secondaryTarget();
        if (!secondary) throw err;
        const res = await secondary.client.send(
          new GetObjectCommand({
            Bucket: secondary.bucket,
            Key: storageId,
            ...(rangeHeader ? { Range: rangeHeader } : {}),
          })
        );
        const size = res.ContentLength ?? null;
        const range = parseRange(rangeHeader, size ?? 0);
        return {
          stream: res.Body as Readable,
          size,
          status: range && rangeHeader ? 206 : 200,
          start: range?.start ?? 0,
          end: range?.end ?? Math.max(0, (size ?? 1) - 1),
        };
      }
    }

    // Local disk
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

export const isCloudStorageActive = isB2Configured;
