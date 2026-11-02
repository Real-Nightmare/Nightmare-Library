import { NextRequest, NextResponse } from "next/server";
import { createHash, randomUUID } from "crypto";
import { resolveSetting } from "@/lib/appsettings";

export const runtime = "nodejs";

/**
 * Sia connection ceremony (Settings → File Storage → "Connect Sia").
 *
 * The official SDK needs a ONE-TIME browser approval before it can use an
 * indexer: requestConnection() → the user opens the approval URL in THEIR
 * browser → waitForApproval() → register(phrase) returns an Sdk whose AppKey
 * persists so restarts never need re-approval.
 *
 * Flow:
 *   POST { indexerUrl?, serviceUrl? } → { sessionId, responseUrl }  (we start waiting)
 *   user approves in the browser (responseUrl)
 *   PUT  { sessionId, phrase? }      → { pending: true } while waiting, then
 *                                    { appKey, phrase } on success (phrase
 *                                    echoes a user-supplied one or a freshly
 *                                    generated 12-word phrase)
 * The app key and phrase come back in clear text so the settings page can
 * drop them into the form — they are secrets and are saved through the
 * normal, masked settings PUT.
 */

// Minimal structural type (see storage.ts): the SDK's browser/Node builds
// type differently and bundler TS resolution picks the browser one.
type SiaBuilder = {
  requestConnection(): Promise<void>;
  waitForApproval(): Promise<void>;
  responseUrl(): string;
  register(mnemonic: string): Promise<{ appKey(): { export(): Buffer } }>;
};

type SiaKit = {
  initSia(): Promise<void>;
  Builder: new (
    indexerUrl: string,
    meta: { id: Buffer; name: string; description: string; serviceUrl: string }
  ) => SiaBuilder;
  generateRecoveryPhrase(): string;
  validateRecoveryPhrase(phrase: string): void;
};

interface SiaSession {
  createdAt: number;
  builder: SiaBuilder;
  /** Resolves when the user approves; rejects on connection failure. */
  approval: Promise<void>;
}

const sessions = new Map<string, SiaSession>();
const SESSION_TTL_MS = 15 * 60 * 1000;

function pruneSessions() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, s] of sessions) {
    if (s.createdAt < cutoff) sessions.delete(id);
  }
}

async function siaKit(): Promise<SiaKit> {
  const m = await import("@siafoundation/sia-storage");
  await m.initSia();
  return m as unknown as SiaKit;
}

/** POST /api/settings/sia — start a connection attempt; returns the approval URL. */
export async function POST(req: NextRequest) {
  try {
    let body: { indexerUrl?: string; serviceUrl?: string } = {};
    try {
      body = await req.json();
    } catch {
      // optional body
    }
    const indexerUrl = body.indexerUrl?.trim() || (await resolveSetting("sia_indexer_url")) || "https://sia.storage";
    const serviceUrl = body.serviceUrl?.trim() || (await resolveSetting("sia_service_url")) || indexerUrl;

    const kit = await siaKit();
    const builder = new kit.Builder(indexerUrl, {
      // 32-byte app id — same digest as storage.ts so the indexer always
      // recognizes this app across restarts and redeployments.
      id: createHash("sha256").update(serviceUrl || indexerUrl).digest(),
      name: "Nightmare Library",
      description: "Private EPUB/PDF/video library storing on Sia",
      serviceUrl: serviceUrl || indexerUrl,
    });
    await builder.requestConnection();
    const approval = builder.waitForApproval().catch((error: unknown) => {
      throw error instanceof Error ? error : new Error("Connection approval failed");
    });

    pruneSessions();
    const sessionId = randomUUID();
    sessions.set(sessionId, { createdAt: Date.now(), builder, approval });

    return NextResponse.json({ success: true, sessionId, responseUrl: builder.responseUrl() });
  } catch (error) {
    return NextResponse.json(
      { success: false, message: `Sia connect failed: ${error instanceof Error ? error.message : "unknown error"}` },
      { status: 400 }
    );
  }
}

const APPROVAL_POLL_MS = 20_000;

/**
 * PUT /api/settings/sia — wait (up to ~20s) for approval, then register with
 * the given phrase (or a freshly generated one) and return the AppKey hex.
 */
export async function PUT(req: NextRequest) {
  try {
    const body: { sessionId?: string; phrase?: string } = await req.json();
    const sessionId = body.sessionId ?? "";
    const session = sessions.get(sessionId);
    if (!session) {
      return NextResponse.json(
        { success: false, message: "Connection session not found or expired — press Connect Sia again." },
        { status: 400 }
      );
    }

    try {
      // Never hang the HTTP request: if the user hasn't approved yet, answer
      // pending and let the client poll again.
      await Promise.race([
        session.approval,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("__approval_pending__")), APPROVAL_POLL_MS)),
      ]);
    } catch (error) {
      if (error instanceof Error && error.message === "__approval_pending__") {
        return NextResponse.json({ success: true, pending: true });
      }
      sessions.delete(sessionId);
      return NextResponse.json(
        { success: false, message: `Sia approval failed: ${error instanceof Error ? error.message : "unknown"}` },
        { status: 400 }
      );
    }

    const kit = await siaKit();
    const typed = body.phrase?.trim() || "";
    if (typed) kit.validateRecoveryPhrase(typed); // throws with a clear message
    const phrase = typed || kit.generateRecoveryPhrase();

    const sdk = await session.builder.register(phrase);
    const appKey = sdk.appKey().export().toString("hex");
    sessions.delete(sessionId);

    return NextResponse.json({ success: true, appKey, phrase });
  } catch (error) {
    return NextResponse.json(
      { success: false, message: `Sia registration failed: ${error instanceof Error ? error.message : "unknown error"}` },
      { status: 400 }
    );
  }
}
