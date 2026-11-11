import React, { useEffect, useState } from "react";
import * as api from "../../../api";

/**
 * Settings → Dispatcher Board → Board ↔ Bitrix check → who may answer.
 *
 * The Telegram user ids of the people whose replies ("done", "skip", their own
 * words) and button presses under a Board ↔ Bitrix question count, beside the
 * control channel's operators (owner, 11 November 2026: a teammate's "skip"
 * used to be silently ignored). Anybody else in the group is not obeyed.
 */
export default function BoardBitrixResponders({ ids = [], onSaved }) {
  const [text, setText] = useState(ids.join(", "));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  useEffect(() => { setText(ids.join(", ")); }, [ids.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setBusy(true); setMessage(null);
    try {
      const saved = await api.setBoardBitrixResponders(text);
      setText(saved.join(", "));
      setMessage(saved.length ? `Saved — ${saved.length} ${saved.length === 1 ? "person" : "people"} may answer.` : "Saved — only the owner may answer.");
      onSaved?.(saved);
    } catch (err) { setMessage(err.message); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ margin: "10px 0", padding: 10, border: "1px solid var(--border)", borderRadius: 10 }}>
      <label htmlFor="bbx-responders" style={{ fontWeight: 600, fontSize: 13 }}>Who may answer the questions</label>
      <div style={{ fontSize: 12, color: "var(--text-muted)", margin: "3px 0 6px" }}>
        Telegram user ids, separated by commas. These people (and the owner) can reply &ldquo;done&rdquo; /
        &ldquo;skip&rdquo;, answer in their own words, and press the buttons under a question.
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input id="bbx-responders" className="form-input" style={{ flex: 1, minWidth: 200 }} value={text}
          placeholder="e.g. 8245947790, 6504395610" disabled={busy} onChange={(e) => setText(e.target.value)} />
        <button className="btn btn-ghost touch-target" onClick={save} disabled={busy}>Save who may answer</button>
      </div>
      {message && <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>{message}</div>}
    </div>
  );
}
