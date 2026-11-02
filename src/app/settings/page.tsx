"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface SettingView {
  key: string;
  group: "database" | "storage" | "password";
  label: string;
  secret: boolean;
  hint?: string;
  placeholder?: string;
  value: string | null;
  fromEnv: boolean;
}

type SettingsMap = Record<string, SettingView>;

const GROUPS: { id: "database" | "storage" | "password"; title: string; icon: string; blurb: string }[] = [
  { id: "database", title: "Database", icon: "🗄️", blurb: "Where your library metadata, progress and shelves live." },
  { id: "storage", title: "File Storage", icon: "💾", blurb: "Pool mode spreads books across EVERY configured provider — Custom S3 (R2: 10GB, no download caps), two generic WebDAV slots (Koofr 10GB, pCloud 10GB), Sia (50GB hosted indexer, client-side encrypted) and B2. Stack free tiers to grow the pool; B2 alone caps downloads at 1GB/day." },
  { id: "password", title: "Site Password", icon: "🔒", blurb: "Change the password used to enter the library. Changing it signs out every device." },
];

export default function SettingsPage() {
  const router = useRouter();
  const [settings, setSettings] = useState<SettingsMap | null>(null);
  const [active, setActive] = useState<{ db: string; storage: string } | null>(null);
  const [usage, setUsage] = useState<Record<string, number> | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [message, setMessage] = useState<{ group: string; ok: boolean; text: string } | null>(null);

  // password change
  const [currentPw, setCurrentPw] = useState("");
  const [nextPw, setNextPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [migrating, setMigrating] = useState(false);

  // Sia connection ceremony state (POST → user approves in browser → poll → save key)
  const [sia, setSia] = useState<{
    phase: "idle" | "connecting" | "awaiting" | "saving";
    responseUrl?: string;
    sessionId?: string;
  }>({ phase: "idle" });

  const load = useCallback(async () => {
    const res = await fetch("/api/settings");
    if (res.status === 401) {
      router.push("/");
      return;
    }
    const data = await res.json();
    if (data.success) {
      const map: SettingsMap = {};
      for (const s of data.settings as SettingView[]) map[s.key] = s;
      setSettings(map);
      setActive(data.active);
      setUsage((data.usage as Record<string, number>) ?? null);
    }
  }, [router]);

  useEffect(() => {
    load();
  }, [load]);

  const set = (key: string, value: string) => setDraft((d) => ({ ...d, [key]: value }));

  const saveGroup = async (group: "database" | "storage") => {
    if (!settings) return;
    const keys = Object.values(settings)
      .filter((s) => s.group === group)
      .map((s) => s.key);
    const patch: Record<string, string> = {};
    for (const k of keys) {
      if (draft[k] !== undefined) patch[k] = draft[k];
    }
    if (Object.keys(patch).length === 0) {
      setMessage({ group, ok: false, text: "Nothing changed yet." });
      return;
    }
    setSaving(group);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (data.success) {
        setMessage({
          group,
          ok: true,
          text: `Saved. Active: database = ${data.active.db}, storage = ${data.active.storage}.`,
        });
        setDraft((d) => {
          const next = { ...d };
          for (const k of Object.keys(patch)) delete next[k];
          return next;
        });
        await load();
      } else {
        setMessage({ group, ok: false, text: data.message || "Save failed" });
      }
    } catch {
      setMessage({ group, ok: false, text: "Save failed — network error" });
    } finally {
      setSaving(null);
    }
  };

  const migrateFromB2 = async () => {
    setMigrating(true);
    setMessage({ group: "storage", ok: true, text: "Moving books — this reads and re-uploads every B2 file and can take a while…" });
    try {
      const res = await fetch("/api/settings/migrate", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        const bits = [`moved: ${data.migrated}`, `failed: ${data.failed}`, `skipped (already elsewhere): ${data.skipped}`];
        const fails = Array.isArray(data.failures) && data.failures.length > 0 ? ` — ${data.failures.join("; ")}` : "";
        setMessage({ group: "storage", ok: data.failed === 0, text: `Done (${bits.join(", ")})${fails}` });
        await load();
      } else {
        setMessage({ group: "storage", ok: false, text: data.message || "Migration failed" });
      }
    } catch {
      setMessage({ group: "storage", ok: false, text: "Migration failed — network error" });
    } finally {
      setMigrating(false);
    }
  };

  /**
   * Connect Sia: start the approval ceremony, open the approval page, poll
   * until the user approves, then drop the minted app key + phrase straight
   * into a settings save (which runs the live Sia round-trip test).
   */
  const connectSia = async () => {
    setSia({ phase: "connecting" });
    setMessage({ group: "storage", ok: true, text: "Starting Sia connection — approve it in your browser…" });
    try {
      const res = await fetch("/api/settings/sia", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ indexerUrl: draft.sia_indexer_url, serviceUrl: draft.sia_service_url }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.message || "Connect failed");
      setSia({ phase: "awaiting", responseUrl: data.responseUrl, sessionId: data.sessionId });

      for (;;) {
        await new Promise((r) => setTimeout(r, 3000));
        const poll = await fetch("/api/settings/sia", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: data.sessionId, phrase: draft.sia_recovery_phrase }),
        });
        const pollData = await poll.json();
        if (!pollData.success) throw new Error(pollData.message || "Sia approval failed");
        if (pollData.pending) continue;

        // Minted — save the app key + phrase immediately. Empty fields must be
        // omitted (an empty value clears a stored override).
        setSia({ phase: "saving" });
        const patch: Record<string, string> = {
          sia_recovery_phrase: pollData.phrase,
          sia_app_key: pollData.appKey,
        };
        const idx = (draft.sia_indexer_url ?? "").trim();
        const svc = (draft.sia_service_url ?? "").trim();
        if (idx) patch.sia_indexer_url = idx;
        if (svc) patch.sia_service_url = svc;

        const save = await fetch("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        const saveData = await save.json();
        if (saveData.success) {
          setMessage({
            group: "storage",
            ok: true,
            text: `Sia connected, round-trip verified and saved. Active storage: ${saveData.active?.storage ?? "sia"}.`,
          });
        } else {
          setMessage({ group: "storage", ok: false, text: `Connected, but saving failed: ${saveData.message}` });
          set("sia_recovery_phrase", pollData.phrase);
          set("sia_app_key", pollData.appKey);
        }
        setSia({ phase: "idle" });
        await load();
        return;
      }
    } catch (e) {
      setMessage({ group: "storage", ok: false, text: e instanceof Error ? e.message : "Sia connect failed" });
      setSia({ phase: "idle" });
    }
  };

  const changePassword = async () => {
    if (nextPw && nextPw !== confirmPw) {
      setMessage({ group: "password", ok: false, text: "New passwords do not match." });
      return;
    }
    setSaving("password");
    try {
      const res = await fetch("/api/settings/password", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current: currentPw, next: nextPw }),
      });
      const data = await res.json();
      if (data.success) {
        setMessage({ group: "password", ok: true, text: data.message });
        setCurrentPw("");
        setNextPw("");
        setConfirmPw("");
        // Signing secret changed — bounce to login after a beat.
        setTimeout(() => router.push("/"), 1500);
      } else {
        setMessage({ group: "password", ok: false, text: data.message || "Failed" });
      }
    } catch {
      setMessage({ group: "password", ok: false, text: "Failed — network error" });
    } finally {
      setSaving(null);
    }
  };

  const field = (key: string) => {
    if (!settings) return null;
    const s = settings[key];
    if (!s) return null;
    const isSelect = key === "db_provider" || key === "storage_provider";
    const draftVal = draft[key];
    return (
      <div className="form-group" key={key}>
        <label>
          {s.label}
          {s.fromEnv && <span className="env-tag">from env</span>}
          {!s.fromEnv && s.value && <span className="env-tag override-tag">override set</span>}
        </label>
        {isSelect ? (
          <select
            className="select-input"
            value={draftVal ?? ""}
            onChange={(e) => set(key, e.target.value)}
          >
            <option value="">Auto-detect</option>
            {key === "db_provider" && (
              <>
                <option value="supabase">Supabase Postgres</option>
                <option value="turso">Turso (remote SQLite)</option>
                <option value="local">Local SQLite file</option>
              </>
            )}
            {key === "storage_provider" && (
              <>
                <option value="pool">Pool — spread across every configured provider</option>
                <option value="s3">Custom S3 (R2, iDrive e2, Filebase…)</option>
                <option value="b2">Backblaze B2</option>
                <option value="b2_cascade">B2 + cascade failover</option>
                <option value="local">Server disk (local)</option>
              </>
            )}
          </select>
        ) : (
          <input
            className="text-input"
            type={s.secret ? "password" : "text"}
            value={draftVal ?? ""}
            placeholder={
              s.secret
                ? s.value
                  ? `${s.value} (leave blank to keep)`
                  : "not set"
                : s.value || s.placeholder || ""
            }
            onChange={(e) => set(key, e.target.value)}
            autoComplete="off"
          />
        )}
        {s.hint && <p className="settings-hint">{s.hint}</p>}
      </div>
    );
  };

  return (
    <div className="page-body">
      <nav className="navbar">
        <div className="nav-brand">
          <span>⚙️</span>
          <span>Settings</span>
        </div>
        <div className="nav-actions">
          <button className="btn-icon" onClick={() => router.push("/dashboard")} title="Back to library">
            ←
          </button>
        </div>
      </nav>

      <main className="settings-main">
        {active && (
          <div className="settings-active-bar">
            Active — database: <b>{active.db}</b> · storage: <b>{active.storage}</b>
          </div>
        )}

        {GROUPS.map((g) => (
          <section className="settings-card" key={g.id}>
            <h2>
              <span>{g.icon}</span> {g.title}
            </h2>
            <p className="settings-blurb">{g.blurb}</p>

            {g.id === "database" && settings && (
              <>
                {field("db_provider")}
                {field("supabase_url")}
                {field("supabase_service_key")}
                {field("turso_url")}
                {field("turso_token")}
                <button className="btn-primary" disabled={saving === "database"} onClick={() => saveGroup("database")}>
                  {saving === "database" ? "Testing & saving..." : "Save database settings"}
                </button>
              </>
            )}

            {g.id === "storage" && settings && usage && (
              <div className="form-group">
                <label>Storage usage (pool budget vs. stored bytes)</label>
                {Object.keys(usage).length === 0 ? (
                  <p className="settings-hint">No files stored yet.</p>
                ) : (
                  <p className="settings-hint">
                    {Object.entries(usage)
                      .map(([p, bytes]) => `${p}: ${(bytes / 1024 ** 3).toFixed(2)} GB`)
                      .join(" · ")}
                  </p>
                )}
              </div>
            )}

            {g.id === "storage" && settings && (
              <>
                {field("storage_provider")}
                {field("b2_key_id")}
                {field("b2_application_key")}
                {field("b2_bucket")}
                {field("b2_region")}
                <div className="settings-divider" />
                <h3 className="settings-sub">Custom S3-compatible provider — no download caps</h3>
                {field("s3_endpoint")}
                {field("s3_key_id")}
                {field("s3_secret")}
                {field("s3_bucket")}
                {field("s3_region")}
                {field("s3_capacity_gb")}
                <div className="settings-divider" />
                <h3 className="settings-sub">Custom S3 #2 (second pool slot / failover)</h3>
                {field("b2_cascade_endpoint")}
                {field("b2_cascade_key_id")}
                {field("b2_cascade_secret")}
                {field("b2_cascade_bucket")}
                {field("b2_cascade_region")}
                {field("b2_cascade_capacity_gb")}
                <div className="settings-divider" />
                <h3 className="settings-sub">WebDAV — Koofr / pCloud (free forever, no card)</h3>
                {field("webdav_endpoint")}
                {field("webdav_username")}
                {field("webdav_password")}
                {field("webdav_base_path")}
                {field("webdav_capacity_gb")}
                <div className="settings-divider" />
                <h3 className="settings-sub">WebDAV #2 (second free account)</h3>
                {field("webdav2_endpoint")}
                {field("webdav2_username")}
                {field("webdav2_password")}
                {field("webdav2_base_path")}
                {field("webdav2_capacity_gb")}
                <div className="settings-divider" />
                <h3 className="settings-sub">Sia — decentralized, client-side encrypted (50GB free, no card)</h3>
                {field("sia_indexer_url")}
                {field("sia_service_url")}
                {field("sia_recovery_phrase")}
                {field("sia_app_key")}
                {field("sia_capacity_gb")}
                <button
                  className="btn-primary"
                  disabled={sia.phase !== "idle"}
                  onClick={connectSia}
                >
                  {sia.phase === "connecting"
                    ? "Starting connection…"
                    : sia.phase === "awaiting"
                      ? "Waiting for your approval…"
                      : sia.phase === "saving"
                        ? "Saving app key…"
                        : "Connect Sia"}
                </button>
                {sia.phase === "awaiting" && sia.responseUrl && (
                  <p className="settings-hint">
                    Approve the connection in your browser: {" "}
                    <a href={sia.responseUrl} target="_blank" rel="noreferrer">
                      open the approval page
                    </a>{" "}
                    — we keep polling and save the minted app key automatically (~30 seconds).
                  </p>
                )}
                <p className="settings-hint">
                  One-time approval per indexer. Books are encrypted on this server before they leave, so nothing
                  readable ever touches the Sia hosts. Keep the recovery phrase safe — nothing on Sia is recoverable
                  without it.
                </p>
                <button className="btn-primary" disabled={saving === "storage"} onClick={() => saveGroup("storage")}>
                  {saving === "storage" ? "Testing & saving..." : "Save storage settings"}
                </button>
                <div className="settings-divider" />
                <h3 className="settings-sub">Move books off B2</h3>
                <button className="btn-primary" disabled={migrating} onClick={migrateFromB2}>
                  {migrating ? "Moving books…" : "Move all books from B2 → current provider"}
                </button>
                <p className="settings-hint">
                  Copies every B2-stored book to the active provider (Custom S3 or local disk), server-side, and keeps
                  the B2 copies as a backup. If B2's daily download cap (1GB/day, resets midnight UTC) is exhausted,
                  some books will fail — re-run this after the reset.
                </p>
              </>
            )}

            {g.id === "password" && (
              <>
                <div className="form-group">
                  <label>Current password</label>
                  <input
                    className="text-input"
                    type="password"
                    value={currentPw}
                    onChange={(e) => setCurrentPw(e.target.value)}
                    autoComplete="current-password"
                  />
                </div>
                <div className="form-group">
                  <label>New password (leave blank to revert to the env password)</label>
                  <input
                    className="text-input"
                    type="password"
                    value={nextPw}
                    onChange={(e) => setNextPw(e.target.value)}
                    placeholder="at least 8 characters"
                    autoComplete="new-password"
                  />
                </div>
                <div className="form-group">
                  <label>Confirm new password</label>
                  <input
                    className="text-input"
                    type="password"
                    value={confirmPw}
                    onChange={(e) => setConfirmPw(e.target.value)}
                    autoComplete="new-password"
                  />
                </div>
                <button className="btn-primary" disabled={saving === "password"} onClick={changePassword}>
                  {saving === "password" ? "Changing..." : "Change password"}
                </button>
              </>
            )}

            {message?.group === g.id && (
              <p className={message.ok ? "settings-msg ok" : "settings-msg err"}>{message.text}</p>
            )}
          </section>
        ))}

        <p className="settings-note">
          Secrets are masked after save (only the first 3 characters are kept visible). Values entered here are
          stored in the app database as overrides; environment variables still work as fallbacks and are used
          wherever no override is set.
        </p>
      </main>
    </div>
  );
}
