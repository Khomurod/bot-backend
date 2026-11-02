import React from "react";

import * as api from "../../../api";

/**
 * The AI settings read (`GET /api/settings/ai`) and its save, for the AI
 * sections of Settings.
 *
 * Until November 2026 one AI & Autonomy screen loaded this once and handed the
 * pieces down. It is now four sections — AI Providers, AI Tasks, Wenze's
 * Questions, Provider Terms — and three of them need part of the same answer:
 * the providers (Provider Terms watches their pages), and the learning switch
 * (Wenze's Questions). Each section reads it for itself, so a section opened
 * from a link works with nothing else on screen.
 *
 * `flash` reports into the section's own banner, next to the card that saved.
 */
export default function useAiSettings() {
  const [data, setData] = React.useState(null);
  const [status, setStatus] = React.useState(null);
  // Only matters while `data` is still null: a section whose first read
  // failed offers Retry instead of spinning for as long as it is open.
  const [loadFailed, setLoadFailed] = React.useState(false);

  const flash = React.useCallback((type, text) => setStatus({ type, text }), []);

  const load = React.useCallback(async () => {
    try {
      setData(await api.getAiSettings());
      setLoadFailed(false);
    } catch (err) {
      setLoadFailed(true);
      flash("error", err?.detail || err?.message || "Could not load AI settings.");
    }
  }, [flash]);

  React.useEffect(() => { load(); }, [load]);

  const retry = React.useCallback(() => {
    setStatus(null);
    return load();
  }, [load]);

  const saveSettings = React.useCallback(async (patch) => {
    try {
      await api.updateAiSettings(patch);
      flash("success", "Saved.");
      load();
    } catch (err) {
      flash("error", err?.detail || err?.message || "Could not save.");
    }
  }, [flash, load]);

  return { data, status, flash, load, saveSettings, loadFailed, retry };
}

/** The section's banner: what the last save or load said. */
export function AiStatus({ status }) {
  if (!status) return null;
  return <div className={`alert alert-${status.type}`} style={{ marginBottom: 12 }}>{status.text}</div>;
}

/** Shown until the first read answers; after a failed read, a Retry. */
export function AiLoading({ failed = false, onRetry }) {
  if (failed) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span className="muted">AI settings did not load.</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>Retry</button>
      </div>
    );
  }
  return <div className="loading"><div className="spinner" /> Loading AI settings…</div>;
}
