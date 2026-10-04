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
 * - webdav/webdav2 : generic WebDAV (Koofr 10GB, pCloud 10GB — free forever, no card)
 * - local      : server disk .data/books/ (zero-config dev/self-host)
 *
 * COMPRESSION: book files (EPUB/PDF) are gzip-compressed CLIENT-SIDE before
 * upload (double-zip: an EPUB is already a zip — gzipping the whole archive
 * again reaps the remaining redundancy, typically 5-15% extra on real books,
 * more on PDFs). Per-file `file_encoding` ('gzip'|'raw') records what is
 * stored, so old uploads keep working and every read decompresses
 * transparently. Video stays raw (incompressible) and streams with HTTP Range.
 */

export type StorageProvider = "b2" | "b2_cascade" | "s3" | "pool" | "local" | "webdav" | "webdav2";

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

/**
 * Custom S3-compatible provider — Cloudflare R2, Storj, iDrive e2, Filebase,
 * Tigris… anything that speaks the S3 API. Unlike B2 there is no daily
 * download cap on R2 (zero egress fees), which is exactly why this exists.
 */
async function customS3Config(): Promise<S3Config | null> {
  const endpoint = await resolveSetting("s3_endpoint");
  const keyId = await resolveSetting("s3_key_id");
  const appKey = await resolveSetting("s3_secret");
  const bucket = await resolveSetting("s3_bucket");
  if (!endpoint || !keyId || !appKey || !bucket) return null;
  const region = (await resolveSetting("s3_region")) || "auto"; // R2 wants "auto"
  return { keyId, appKey, bucket, region, endpoint };
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

/**
 * Generic WebDAV slot — the cheapest way to add free-forever capacity with NO
 * credit card: Koofr (10GB, app.koofr.net/dav/Koofr) and pCloud
 * (webdav.pcloud.com) both expose plain WebDAV on their free tiers. One
 * adapter covers any provider that speaks the protocol.
 */
interface WebDavConfig {
  endpoint: string;
  username: string;
  password: string;
  basePath: string;
}

export type WebDavSlotId = "webdav" | "webdav2";

async function webdavConfig(slot: WebDavSlotId): Promise<WebDavConfig | null> {
  const p = slot === "webdav" ? "webdav" : "webdav2";
  const endpoint = await resolveSetting(`${p}_endpoint`);
  const username = await resolveSetting(`${p}_username`);
  const password = await resolveSetting(`${p}_password`);
  if (!endpoint || !username || !password) return null;
  const raw = (await resolveSetting(`${p}_base_path`)) || "/nightmare-library";
  const bp = raw.startsWith("/") ? raw : `/${raw}`;
  return { endpoint: endpoint.replace(/\/+$/, ""), username, password, basePath: bp.replace(/\/+$/, "") };
}

function webdavAuth(wd: WebDavConfig): string {
  return `Basic ${Buffer.from(`${wd.username}:${wd.password}`).toString("base64")}`;
}

function webdavUrl(wd: WebDavConfig, relPath: string): string {
  return `${wd.endpoint}${wd.basePath}/${relPath.replace(/^\/+/, "")}`;
}

/** PUT with automatic MKCOL of missing parent folders (WebDAV has no mkdir -p). */
async function webdavPut(wd: WebDavConfig, relPath: string, data: Buffer): Promise<boolean> {
  const url = webdavUrl(wd, relPath);
  const headers = { Authorization: webdavAuth(wd), "Content-Type": "application/octet-stream" };
  const body = () => new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  let res = await fetch(url, { method: "PUT", headers, body: body() as unknown as BodyInit });
  if (res.status === 409 || res.status === 404) {
    try {
      const u = new URL(url);
      const segs = u.pathname.split("/").filter(Boolean);
      let prefix = "";
      for (let i = 0; i < segs.length - 1; i++) {
        prefix += `/${segs[i]}`;
        await fetch(`${u.origin}${prefix}`, { method: "MKCOL", headers: { Authorization: webdavAuth(wd) } }).catch(() => undefined);
      }
      res = await fetch(url, { method: "PUT", headers, body: body() as unknown as BodyInit });
    } catch {
      return false;
    }
  }
  return res.ok;
}

async function webdavGet(wd: WebDavConfig, relPath: string): Promise<Buffer> {
  const res = await fetch(webdavUrl(wd, relPath), { headers: { Authorization: webdavAuth(wd) } });
  if (!res.ok) throw new Error(`WebDAV GET failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function webdavDelete(wd: WebDavConfig, relPath: string): Promise<void> {
  try {
    await fetch(webdavUrl(wd, relPath), { method: "DELETE", headers: { Authorization: webdavAuth(wd) } });
  } catch {
    // already gone — fine
  }
}

/** Connectivity probe for the Settings save path. Returns an error string or null. */
export async function webdavTest(wd: WebDavConfig): Promise<string | null> {
  try {
    const res = await fetch(`${wd.endpoint}/`, { method: "OPTIONS", headers: { Authorization: webdavAuth(wd) } });
    if (res.status === 401 || res.status === 403) return "authentication failed — check username and (app) password";
    if (!res.ok && res.status !== 405) return `HTTP ${res.status}`;
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "unreachable";
  }
}

export interface WebDavSlot {
  id: WebDavSlotId;
  label: string;
  wd: WebDavConfig;
  capacityBytes: number;
}

/** Every configured WebDAV slot (Koofr, pCloud, Nextcloud, …). */
export async function webdavSlots(): Promise<WebDavSlot[]> {
  const slots: WebDavSlot[] = [];
  for (const id of ["webdav", "webdav2"] as WebDavSlotId[]) {
    const wd = await webdavConfig(id);
    if (!wd) continue;
    const raw = await resolveSetting(`${id}_capacity_gb`);
    const v = Number(raw);
    const gb = Number.isFinite(v) && v > 0 ? v : 10;
    slots.push({ id, label: id === "webdav" ? "WebDAV" : "WebDAV #2", wd, capacityBytes: gb * 1024 ** 3 });
  }
  return slots;
}

/**
 * One configured S3 endpoint that can participate in the storage POOL.
 * "b2_cascade" is reused as a fully generic second custom-S3 slot.
 */
export interface StorageSlot {
  id: "b2" | "s3" | "b2_cascade";
  label: string;
  cfg: S3Config;
  capacityBytes: number;
}

async function slotCapacityGb(id: "b2" | "s3" | "b2_cascade"): Promise<number> {
  if (id === "b2") return 10; // B2 free tier
  const raw = await resolveSetting(id === "s3" ? "s3_capacity_gb" : "b2_cascade_capacity_gb");
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : id === "s3" ? 10 : 25;
}

/** Every S3-compatible slot that currently has credentials configured. */
export async function storageSlots(): Promise<StorageSlot[]> {
  const slots: StorageSlot[] = [];
  const s3c = await customS3Config();
  if (s3c) slots.push({ id: "s3", label: "Custom S3", cfg: s3c, capacityBytes: (await slotCapacityGb("s3")) * 1024 ** 3 });
  const cas = await cascadeConfig();
  if (cas) slots.push({ id: "b2_cascade", label: "Custom S3 #2", cfg: cas, capacityBytes: (await slotCapacityGb("b2_cascade")) * 1024 ** 3 });
  const b2 = await s3Config();
  if (b2) slots.push({ id: "b2", label: "Backblaze B2", cfg: b2, capacityBytes: (await slotCapacityGb("b2")) * 1024 ** 3 });
  return slots;
}

type PoolPick = { id: "b2" | "s3" | "b2_cascade"; cfg: S3Config } | { id: WebDavSlotId; wd: WebDavConfig };

/**
 * POOL: pick the slot with the most free space left (capacity minus recorded
 * usage) across S3-compatible AND WebDAV slots. This is what makes several
 * free-forever providers act as one big bucket — the sum of their free tiers
 * is the pool's total storage.
 */
async function pickPoolSlot(): Promise<PoolPick | null> {
  const s3 = await storageSlots();
  const wds = await webdavSlots();
  if (s3.length === 0 && wds.length === 0) return null;
  let usage: Record<string, number> = {};
  try {
    const { providerUsage } = await import("./repo");
    usage = await providerUsage();
  } catch {
    // usage unknown — treat all as empty
  }
  const candidates: PoolPick[] = [
    ...s3.map((s) => ({ id: s.id, cfg: s.cfg } as PoolPick)),
    ...wds.map((s) => ({ id: s.id, wd: s.wd } as PoolPick)),
  ];
  let best = candidates[0];
  let bestFree = -Infinity;
  for (const c of candidates) {
    const cap =
      "cfg" in c
        ? (s3.find((s) => s.id === c.id)?.capacityBytes ?? 0)
        : (wds.find((s) => s.id === c.id)?.capacityBytes ?? 0);
    const free = cap - (usage[c.id] ?? 0);
    if (free > bestFree) {
      bestFree = free;
      best = c;
    }
  }
  return best;
}

function clientFor(cfg: S3Config): S3Client {
  return new S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint ?? `https://s3.${cfg.region}.backblazeb2.com`,
    credentials: { accessKeyId: cfg.keyId, secretAccessKey: cfg.appKey },
  });
}

/**
 * Server-side write of a book payload to a specific configured slot. Used by
 * saveBookFile/migration — bytes never touch the browser.
 */
export async function putObjectToSlot(
  provider: "b2" | "s3" | "b2_cascade" | WebDavSlotId,
  key: string,
  data: Buffer
): Promise<boolean> {
  try {
    if (provider === "webdav" || provider === "webdav2") {
      const wd = await webdavConfig(provider);
      if (!wd) return false;
      return await webdavPut(wd, key, data);
    }
    const slot = (await storageSlots()).find((s) => s.id === provider);
    if (!slot) return false;
    await clientFor(slot.cfg).send(new PutObjectCommand({ Bucket: slot.cfg.bucket, Key: key, Body: data }));
    return true;
  } catch (error) {
    console.error("putObjectToSlot failed:", error);
    return false;
  }
}

/** Which provider new uploads go to (settings override, else auto-detect). */
export async function activeStorageProvider(): Promise<StorageProvider> {
  const { resolveStorageProvider } = await import("./appsettings");
  const p = await resolveStorageProvider();
  return p === "b2_cascade" ? "b2" : p; // cascade is a read/failover partner; uploads still target B2
}

/**
 * Config for the ACTIVE upload target: the chosen pool slot when pooling,
 * the custom S3 provider when selected, otherwise B2. Returns null when the
 * chosen provider has no credentials — callers then fall back to local saves.
 */
export async function activeS3Config(): Promise<{ cfg: S3Config; provider: "b2" | "s3" | "b2_cascade" } | null> {
  const active = await activeStorageProvider();
  if (active === "s3") {
    const cfg = await customS3Config();
    return cfg ? { cfg, provider: "s3" } : null;
  }
  if (active === "pool") {
    const slot = await pickPoolSlot();
    // A WebDAV pick has no presign path — return null so uploads fall back to
    // the server-side save, which routes to the WebDAV slot directly.
    return slot && "cfg" in slot ? { cfg: slot.cfg, provider: slot.id } : null;
  }
  const cfg = await s3Config();
  return cfg ? { cfg, provider: "b2" } : null;
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

/** Presigned PUT for the browser to upload directly to the active S3 provider. */
export async function createPresignedUpload(
  bookId: string,
  fileType: string,
  contentType: string
): Promise<{ uploadUrl: string; storageId: string; provider: StorageProvider } | null> {
  const active = await activeS3Config();
  if (!active) return null;
  const key = bookObjectKey(bookId, fileType);
  const command = new PutObjectCommand({ Bucket: active.cfg.bucket, Key: key, ContentType: contentType });
  const uploadUrl = await getSignedUrl(clientFor(active.cfg), command, { expiresIn: 900 });
  return { uploadUrl, storageId: key, provider: active.provider };
}

/** Verifies a file landed in the active S3 provider after a presigned upload. */
export async function verifyUpload(storageId: string): Promise<number | null> {
  const active = await activeS3Config();
  if (!active) return null;
  try {
    const res = await clientFor(active.cfg).send(
      new HeadObjectCommand({ Bucket: active.cfg.bucket, Key: storageId })
    );
    return res.ContentLength ?? null;
  } catch {
    return null;
  }
}

/**
 * Server-side save to the ACTIVE provider — custom S3, the pool's freest
 * slot, or B2 — falling back to local disk when none is usable. Used by the
 * upload fallback path AND the migration, so both always honor the user's
 * provider choice.
 */
export async function saveBookFile(
  bookId: string,
  fileType: string,
  payload: Buffer
): Promise<StoredFile> {
  const active = await activeStorageProvider();
  if (active === "pool") {
    // The pool may pick a WebDAV slot, which has no presign path — write here.
    const pick = await pickPoolSlot();
    if (pick) {
      const key = bookObjectKey(bookId, fileType);
      if (await putObjectToSlot(pick.id, key, payload)) {
        return { provider: pick.id, storageId: key };
      }
    }
  }
  if (active === "s3" || active === "pool" || active === "b2") {
    const target = await activeS3Config();
    if (target) {
      const key = bookObjectKey(bookId, fileType);
      if (await putObjectToSlot(target.provider, key, payload)) {
        return { provider: target.provider, storageId: key };
      }
    }
  }
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
    if (provider === "s3") {
      const cfg = await customS3Config();
      if (!cfg) return null;
      const res = await clientFor(cfg).send(
        new GetObjectCommand({ Bucket: cfg.bucket, Key: storageId })
      );
      return tryDecompress(await streamToBuffer(res.Body), encoding);
    }
    if (provider === "webdav" || provider === "webdav2") {
      const wd = await webdavConfig(provider);
      if (!wd) return null;
      return tryDecompress(await webdavGet(wd, storageId), encoding);
    }
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
    if (provider === "s3") {
      const cfg = await customS3Config();
      if (cfg) {
        try {
          await clientFor(cfg).send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: storageId }));
        } catch {
          // ignore
        }
      }
      return;
    }
    if (provider === "webdav" || provider === "webdav2") {
      const wd = await webdavConfig(provider);
      if (wd) await webdavDelete(wd, storageId);
      return;
    }
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

// ---------------- Small-object helpers (covers) ----------------
// Covers live in B2 (bucket) when B2 is configured, else on local disk.
// The serverless filesystem is EPHEMERAL — local-only covers vanish between
// instances/deployments, which is why covers 404'd in production.

/** Put a small object (e.g. cover) into the active S3 provider. Returns the storage key, or null when no provider is available. */
export async function putSmallObject(
  key: string,
  data: Buffer,
  contentType: string
): Promise<string | null> {
  // Try the active provider first, then B2 — covers are tiny and a fallback
  // write keeps covers working while providers are being swapped over.
  // A WebDAV pool pick has no S3 config — write the small object there first.
  if ((await activeStorageProvider()) === "pool") {
    const pick = await pickPoolSlot();
    if (pick && "wd" in pick && (await webdavPut(pick.wd, key, data))) return key;
  }
  const candidates: S3Config[] = [];
  const active = await activeS3Config();
  if (active) candidates.push(active.cfg);
  const b2 = await s3Config();
  if (b2 && !candidates.some((c) => c.bucket === b2.bucket && c.endpoint === b2.endpoint)) candidates.push(b2);
  for (const cfg of candidates) {
    try {
      await clientFor(cfg).send(
        new PutObjectCommand({ Bucket: cfg.bucket, Key: key, Body: data, ContentType: contentType })
      );
      return key;
    } catch (error) {
      console.error("putSmallObject failed:", error);
    }
  }
  return null;
}

/** Read a small object from the active provider, then cascade, then B2 (null when missing everywhere). */
export async function getSmallObject(key: string): Promise<Buffer | null> {
  const candidates: S3Config[] = [];
  const active = await activeS3Config();
  if (active) candidates.push(active.cfg);
  const cascade = await cascadeConfig();
  if (cascade) candidates.push(cascade);
  const b2 = await s3Config();
  if (b2) candidates.push(b2);
  for (const cfg of candidates) {
    try {
      const res = await clientFor(cfg).send(
        new GetObjectCommand({ Bucket: cfg.bucket, Key: key })
      );
      return await streamToBuffer(res.Body);
    } catch (error) {
      if ((error as { name?: string })?.name !== "NoSuchKey" && (error as { name?: string })?.name !== "NotFound") {
        console.error("getSmallObject failed:", error);
      }
    }
  }
  for (const id of ["webdav", "webdav2"] as WebDavSlotId[]) {
    const wd = await webdavConfig(id);
    if (!wd) continue;
    try {
      return await webdavGet(wd, key);
    } catch (error) {
      console.error("getSmallObject (WebDAV) failed:", error);
    }
  }
  return null;
}

/** Delete a small object from every configured provider (best-effort). */
export async function deleteSmallObject(key: string): Promise<void> {
  const candidates: S3Config[] = [];
  const active = await activeS3Config();
  if (active) candidates.push(active.cfg);
  const cascade = await cascadeConfig();
  if (cascade) candidates.push(cascade);
  const b2 = await s3Config();
  if (b2) candidates.push(b2);
  for (const cfg of candidates) {
    try {
      await clientFor(cfg).send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
    } catch {
      // best-effort
    }
  }
  for (const id of ["webdav", "webdav2"] as WebDavSlotId[]) {
    const wd = await webdavConfig(id);
    if (wd) await webdavDelete(wd, key);
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
    if (provider === "s3") {
      const cfg = await customS3Config();
      if (!cfg) return null;
      const res = await clientFor(cfg).send(
        new GetObjectCommand({
          Bucket: cfg.bucket,
          Key: storageId,
          ...(rangeHeader ? { Range: rangeHeader } : {}),
        })
      );
      return rangeResult(res.Body as Readable, res.ContentLength ?? null, rangeHeader);
    }
    if (provider === "webdav" || provider === "webdav2") {
      const wd = await webdavConfig(provider);
      if (!wd) return null;
      const res = await fetch(webdavUrl(wd, storageId), {
        headers: { Authorization: webdavAuth(wd), ...(rangeHeader ? { Range: rangeHeader } : {}) },
      });
      if (!res.ok && res.status !== 206) throw new Error(`WebDAV media failed: HTTP ${res.status}`);
      const cr = res.headers.get("content-range");
      let size: number | null = cr
        ? Number(cr.split("/")[1])
        : Number(res.headers.get("content-length")) || null;
      let start = 0;
      let end = Math.max(0, (size ?? 1) - 1);
      const status: 200 | 206 = res.status === 206 ? 206 : 200;
      const m = status === 206 && cr ? /bytes (\d+)-(\d+)\/(\d+)/.exec(cr) : null;
      if (m) {
        start = Number(m[1]);
        end = Number(m[2]);
        size = Number(m[3]);
      }
      const body = res.body
        ? Readable.fromWeb(res.body as unknown as import("stream/web").ReadableStream)
        : Readable.from([]);
      return { stream: body, size, status, start, end };
    }
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
