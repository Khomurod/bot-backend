import React, { useState } from "react";
import * as api from "../../../api";
import PreviewResult from "./PreviewResult";
import { TARGET_OPTIONS } from "./scopes";

/**
 * Paste or choose a .env file → Preview → Save.
 *
 * Save is enabled only for the exact text and app that were previewed and
 * found savable; any edit locks it again. The text is cleared from the page
 * the moment it is saved. The server checks everything once more on Save.
 */
export default function UploadCard({ disabled, onSaved }) {
  const [target, setTarget] = useState("bot");
  const [text, setText] = useState("");
  const [preview, setPreview] = useState(null);
  const [previewedFor, setPreviewedFor] = useState(null);
  const [busy, setBusy] = useState(null); // "preview" | "save" | null
  const [message, setMessage] = useState(null);

  const edited = () => { setPreview(null); setPreviewedFor(null); setMessage(null); };

  const readFile = (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    file.text().then((content) => { setText(content); edited(); });
    event.target.value = "";
  };

  const runPreview = async () => {
    setBusy("preview"); setMessage(null);
    try {
      const p = await api.previewAppSecrets({ target, text });
      setPreview(p);
      setPreviewedFor({ target, text });
    } catch (err) {
      setPreview(null);
      setMessage({ type: "error", text: err.message });
    } finally { setBusy(null); }
  };

  const save = async () => {
    const restarts = preview.restartsThisApp;
    const question = restarts
      ? "Save these settings? This app restarts to use them — the panel and the bots are away for about a minute."
      : "Save these settings for the Samsara service? It picks them up within about a minute.";
    if (!window.confirm(question)) return;
    setBusy("save"); setMessage(null);
    try {
      const out = await api.saveAppSecrets({ target, text, baseVersion: preview.baseVersion });
      setText("");
      setPreview(null);
      setPreviewedFor(null);
      setMessage({
        type: "success",
        text: out.restarting
          ? `Saved as version ${out.versionId}. The app is restarting now — reload this page in about a minute.`
          : `Saved as version ${out.versionId}.`,
      });
      onSaved(out);
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally { setBusy(null); }
  };

  const savable = Boolean(preview && preview.canSave && previewedFor
    && previewedFor.text === text && previewedFor.target === target);

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h3 style={{ marginTop: 0 }}>Upload a .env file</h3>
      <p style={{ color: "var(--text-secondary)", marginTop: 0 }}>
        Paste the environment of one app, or choose its .env file. Names not in the file are removed from
        that app's own values; values both apps share are only added or changed, never removed by one app's file.
        <code> DATABASE_URL</code>, <code>INTEGRATION_SECRET_KEY</code> and <code>PORT</code> stay in Coolify.
      </p>
      <div className="form-group">
        <label htmlFor="secrets-target" style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>For which app</label>
        <select
          id="secrets-target"
          className="form-control"
          value={target}
          disabled={disabled || busy !== null}
          onChange={(e) => { setTarget(e.target.value); edited(); }}
        >
          {TARGET_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      <div className="form-group">
        <label htmlFor="secrets-text" style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>.env contents</label>
        <textarea
          id="secrets-text"
          className="form-control"
          rows={10}
          spellCheck={false}
          autoComplete="off"
          style={{ fontFamily: "monospace" }}
          value={text}
          disabled={disabled || busy !== null}
          onChange={(e) => { setText(e.target.value); edited(); }}
          placeholder={"BOT_TOKEN=...\nJWT_SECRET=..."}
        />
        <input type="file" accept=".env,text/plain" aria-label="Choose a .env file" onChange={readFile}
          disabled={disabled || busy !== null} style={{ marginTop: 8 }} />
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" className="btn btn-secondary" onClick={runPreview}
          disabled={disabled || busy !== null || !text.trim()}>
          {busy === "preview" ? "Checking…" : "Preview changes"}
        </button>
        <button type="button" className="btn btn-primary" onClick={save} disabled={disabled || busy !== null || !savable}>
          {busy === "save" ? "Saving…" : "Save"}
        </button>
      </div>
      <div role="alert" aria-live="polite">
        {message && <div className={`alert alert-${message.type}`} style={{ marginTop: 12, marginBottom: 0 }}>{message.text}</div>}
      </div>
      {preview && <PreviewResult preview={preview} />}
    </div>
  );
}
