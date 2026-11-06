import React, { useCallback, useEffect, useState } from "react";
import * as api from "../../api";
import PageFailure from "../../components/PageFailure";
import { Banner } from "./fields";

/**
 * Settings → Truck Photos.
 *
 * In a driver's group the driver or a fleet manager sends photos of the truck,
 * and somebody writes "outbound" (hand-over) or "inbound" (return). Wenze puts
 * the photos into a PDF and sends it to ONE person, privately, then puts a 👍
 * on the word. Nothing is ever written in the driver's group; when no PDF can
 * be made, that person is told why. docs/architecture/truck-photo-reports.md.
 *
 * THE SWITCH STAYS DISABLED until a test message has reached the recipient:
 * a bot cannot message somebody who has never pressed Start, and the PDFs
 * would go nowhere (the server refuses it too).
 *
 * A failed read shows the failure and a retry, never a form drawn from
 * defaults.
 */
export default function TruckPhotosTab() {
  const [settings, setSettings] = useState(null);
  const [recent, setRecent] = useState([]);
  const [recipient, setRecipient] = useState("");
  const [lookback, setLookback] = useState("3");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setLoadError(null);
    try {
      const data = await api.getTruckPhotos();
      if (!data?.settings) throw new Error("The server did not send the Truck Photos settings.");
      setSettings(data.settings);
      setRecent(Array.isArray(data.recent) ? data.recent : []);
      setRecipient(data.settings.recipientTelegramId || "");
      setLookback(String(data.settings.lookbackHours || 3));
    } catch (err) {
      setSettings(null);
      setLoadError(err);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const run = async (fn) => {
    setBusy(true); setMessage(null);
    try { await fn(); } catch (err) { setMessage({ type: "error", text: err.message }); } finally { setBusy(false); }
  };

  const save = (patch, done) => run(async () => {
    const saved = await api.updateTruckPhotos(patch);
    setSettings(saved);
    setMessage({ type: "success", text: done });
  });

  const testMessage = () => run(async () => {
    const out = await api.sendTruckPhotoTestMessage();
    if (out.ok) {
      if (out.settings) setSettings(out.settings);
      setMessage({ type: "success", text: "The test message arrived. You can switch Truck Photos on." });
    } else {
      setMessage({ type: "error", text: out.message || "The test message could not be sent." });
    }
  });

  if (loading) return <div className="loading"><div className="spinner"></div> Loading…</div>;
  if (!settings) return <PageFailure error={loadError} where="Truck Photos settings" onRetry={load} />;

  const typed = recipient.trim();
  const recipientValid = /^\d{1,19}$/.test(typed);
  const recipientUnsaved = typed !== (settings.recipientTelegramId || "");
  const reached = Boolean(settings.recipientTelegramId && settings.recipientVerifiedAt);
  const lookbackValid = /^\d{1,2}$/.test(lookback.trim()) && Number(lookback) >= 1 && Number(lookback) <= 24;

  return (
    <div>
      <p style={{ color: "var(--text-muted)", marginTop: 0 }}>
        In a driver&apos;s group, the driver or a fleet manager sends photos of the truck, and someone writes{" "}
        <strong>outbound</strong> (the truck is handed over) or <strong>inbound</strong> (it comes back) — as a
        reply to the photos, or on its own. Wenze puts the photos into a PDF and sends it to <strong>one person</strong>,
        privately, then puts a 👍 on the word. The driver&apos;s own word does not count in a one-driver group.
        Nothing is ever written in the group; if no PDF can be made, that person is told why. PDFs are not kept in Wenze.
      </p>
      <Banner message={message} />

      <div className="card">
        <h3 style={{ marginTop: 0 }}>1. Who receives the PDFs</h3>
        <div className="form-group">
          <label htmlFor="tp-recipient">Recipient&apos;s Telegram user ID</label>
          <input id="tp-recipient" className="form-input" inputMode="numeric" placeholder="e.g. 123456789"
            value={recipient} disabled={busy}
            onChange={(e) => setRecipient(e.target.value.replace(/[^\d]/g, ""))} />
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
            Numbers only — the person&apos;s own id, not a group&apos;s. Ask them to open the bot in Telegram and
            press <strong>Start</strong> first: a bot cannot message someone who has not.{" "}
            {reached
              ? `Reached ${new Date(settings.recipientVerifiedAt).toLocaleString()}.`
              : settings.recipientTelegramId ? "Not reached yet — send a test message." : "Not saved yet."}
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button className="btn btn-primary" disabled={busy || !recipientValid || !recipientUnsaved}
            onClick={() => save({ recipientTelegramId: typed }, "Recipient saved. Now send a test message.")}>
            Save recipient
          </button>
          <button className="btn btn-ghost" disabled={busy || !settings.recipientTelegramId || recipientUnsaved}
            onClick={testMessage}>
            Send test message
          </button>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3 style={{ marginTop: 0 }}>2. How far back a plain word looks</h3>
        <div className="form-group">
          <label htmlFor="tp-lookback">Hours before the word</label>
          <input id="tp-lookback" className="form-input" style={{ maxWidth: 120 }} inputMode="numeric"
            value={lookback} disabled={busy} onChange={(e) => setLookback(e.target.value.replace(/[^\d]/g, ""))} />
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
            From 1 to 24 (3 by default). A reply to a photo takes that photo&apos;s album and the photos around it.
            Photos already in an earlier PDF are not sent again.
          </div>
        </div>
        <button className="btn btn-primary" disabled={busy || !lookbackValid || Number(lookback) === settings.lookbackHours}
          onClick={() => save({ lookbackHours: Number(lookback) }, "Saved.")}>
          Save
        </button>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3 style={{ marginTop: 0 }}>3. Switch it on</h3>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={settings.enabled} disabled={busy || (!reached && !settings.enabled)}
            onChange={(e) => save({ enabled: e.target.checked }, e.target.checked ? "Truck Photos is on." : "Switched off.")} />
          <span>Make PDFs from truck photos</span>
        </label>
        {!reached && (
          <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 6 }}>
            Save the recipient and send them a test message first.
          </div>
        )}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3 style={{ marginTop: 0 }}>Latest hand-overs</h3>
        {recent.length === 0 ? <div className="muted">None yet.</div> : (
          <table className="data-table">
            <thead><tr><th>When</th><th>Group</th><th>Word</th><th>Result</th><th>Photos</th></tr></thead>
            <tbody>
              {recent.map((r) => (
                <tr key={r.id}>
                  <td>{new Date(r.createdAt).toLocaleString()}</td>
                  <td>{r.groupName || "—"}{r.triggeredByName ? ` (${r.triggeredByName})` : ""}</td>
                  <td>{r.kind}</td>
                  <td>{STATUS[r.status] || r.status}{r.reason ? ` — ${r.reason}` : ""}{r.aiAssisted ? " (AI checked)" : ""}</td>
                  <td>{r.photoCount}{r.excludedCount ? ` (${r.excludedCount} left out)` : ""}{r.parts > 1 ? `, ${r.parts} PDFs` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

const STATUS = {
  pending: "Being made",
  sent: "Sent",
  failed: "Not sent",
  no_photos: "No photos",
  not_a_handover: "Not about the truck — nothing sent",
  unclear: "Could not tell — nothing sent",
};
