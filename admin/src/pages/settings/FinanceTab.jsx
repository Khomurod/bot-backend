import React, { useCallback, useEffect, useState } from "react";
import * as api from "../../api";
import { Banner } from "./fields";

/**
 * Settings → Finance Monitor.
 *
 * ENABLE IS DISABLED UNTIL A GROUP IS VALIDATED, and that is the whole point of
 * this screen. Money codes are issued in a Telegram group and exist nowhere
 * else; pointing Wenze at the wrong chat means capturing payment messages
 * nobody agreed to capture. So Validate comes first, and it proves the CHAT IN
 * THE FORM — not the one already saved — before it can be committed to.
 *
 * The counts below are counts. No message text, no code, no sender: what the
 * group said is payment data with one auditable home, and the question a
 * settings screen asks is "is this capturing, and does it look right".
 *
 * `ambiguous` and `unparsed` are shown as their own numbers rather than folded
 * into a failure total. The parser has never seen a real message
 * (`lib/finance/moneycode.js` says so), so those two are how a person learns
 * what it cannot read yet — and they are the input for tightening it.
 */
export default function FinanceTab() {
  const [settings, setSettings] = useState(null);
  const [capture, setCapture] = useState(null);
  const [form, setForm] = useState({ chatId: "", duplicateWindowHours: 72 });
  const [message, setMessage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [validated, setValidated] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getFinanceStatus();
      setSettings(data.settings);
      setCapture(data.capture);
      setForm({
        chatId: data.settings?.chatId || "",
        duplicateWindowHours: data.settings?.duplicateWindowHours ?? 72,
      });
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const validate = async () => {
    setBusy(true); setMessage(null); setValidated(null);
    try {
      const out = await api.validateFinanceChat(form.chatId);
      setValidated(out);
      setMessage({
        type: out.ok ? "success" : "error",
        text: out.ok
          ? `That chat is reachable${out.chatTitle ? `: ${out.chatTitle}` : ""}.`
          : out.message || "That chat could not be validated.",
      });
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const save = async (patch) => {
    setBusy(true); setMessage(null);
    try {
      const saved = await api.updateFinanceSettings(patch);
      setSettings(saved);
      setMessage({ type: "success", text: "Saved." });
      await load();
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="loading"><div className="spinner"></div> Loading…</div>;

  // Either already validated and stored, or just proved in this form.
  const canEnable = Boolean(settings?.chatValidatedAt) || Boolean(validated?.ok);

  return (
    <div>
      <p style={{ color: "#94a3b8", marginTop: 0 }}>
        Wenze can keep a record of the money codes issued in one Telegram group, so
        &ldquo;did we already send that one?&rdquo; has an answer that is not scrolling.
        It stores every message in that group <strong>verbatim</strong> and reads only what it
        can read with certainty.
      </p>
      <Banner message={message} />

      <div className="card">
        <h3 style={{ marginTop: 0 }}>The finance group</h3>
        <div className="form-group">
          <label htmlFor="finance-chat-id">Telegram chat ID</label>
          <input
            id="finance-chat-id"
            className="form-input"
            placeholder="e.g. -1001234567890"
            value={form.chatId}
            onChange={(e) => { setForm((f) => ({ ...f, chatId: e.target.value })); setValidated(null); }}
            disabled={busy}
          />
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
            {settings?.chatValidatedAt
              ? `Validated ${new Date(settings.chatValidatedAt).toLocaleString()}`
              : "Not validated yet — the monitor cannot be switched on until it is."}
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button className="btn btn-ghost" onClick={validate} disabled={busy || !form.chatId.trim()}>
            {busy ? "Checking…" : "Validate group"}
          </button>
          <button
            className="btn btn-primary"
            onClick={() => save({ chatId: form.chatId, duplicateWindowHours: Number(form.duplicateWindowHours) })}
            disabled={busy || !form.chatId.trim()}
          >
            Save
          </button>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3 style={{ marginTop: 0 }}>Capture</h3>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="checkbox"
            checked={Boolean(settings?.enabled)}
            disabled={busy || !canEnable}
            onChange={(e) => save({ enabled: e.target.checked })}
          />
          <span>Record the money codes in that group</span>
        </label>
        {!canEnable && (
          <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 6 }}>
            Validate the group first. Capturing payment messages from a chat nobody
            confirmed is the one mistake this feature must not make.
          </div>
        )}

        <div className="form-group" style={{ marginTop: 14, maxWidth: 260 }}>
          <label htmlFor="finance-window">Treat a repeat as suspicious within (hours)</label>
          <input
            id="finance-window"
            type="number"
            className="form-input"
            min={1}
            max={8760}
            value={form.duplicateWindowHours}
            onChange={(e) => setForm((f) => ({ ...f, duplicateWindowHours: e.target.value }))}
            onBlur={() => save({ duplicateWindowHours: Number(form.duplicateWindowHours) })}
            disabled={busy}
          />
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
            The same amount to the same person inside this window is flagged for a person
            to look at. The same <em>code</em> twice is always flagged, whenever it happens.
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3 style={{ marginTop: 0 }}>What has been captured</h3>
        {!capture?.available ? (
          <div className="muted">Nothing has been captured yet.</div>
        ) : (
          <div className="stats-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
            <Stat label="Messages" value={capture.total} />
            <Stat label="Money codes" value={capture.codes} />
            <Stat label="Flagged as repeats" value={capture.duplicates} />
            <Stat label="Read cleanly" value={capture.byStatus?.parsed ?? 0} />
            <Stat label="Unclear" value={capture.byStatus?.ambiguous ?? 0} />
            <Stat label="Could not read" value={capture.byStatus?.unparsed ?? 0} />
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="stat-card">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
