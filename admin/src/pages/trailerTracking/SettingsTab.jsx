/** Trailer Tracking settings. */

import React, { useEffect, useState, useCallback } from "react";
import * as api from "../../api";

function SettingsTab({ flash }) {
  const [settings, setSettings] = useState(null);
  const [effectiveTestGroup, setEffectiveTestGroup] = useState(null);
  const [busy, setBusy] = useState(false);
  const [backfilling, setBackfilling] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await api.getTrailerSettings();
      setSettings(d.settings);
      setEffectiveTestGroup(d.effective_test_group_id);
    } catch (err) { flash("error", err.message); }
  }, [flash]);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setBusy(true);
    try { const d = await api.updateTrailerSettings(settings); setSettings(d.settings); flash("success", "Settings saved."); }
    catch (err) { flash("error", err.message); }
    finally { setBusy(false); }
  };

  const backfill = async () => {
    setBackfilling(true);
    try {
      const d = await api.runTrailerGeocodeBackfill();
      const s = d.summary || {};
      flash("success", `Geocoded ${s.geocoded || 0}, approximate ${s.approximate || 0}, failed ${s.failed || 0}. ${s.remaining || 0} still pending.`);
    } catch (err) { flash("error", err.message); }
    finally { setBackfilling(false); }
  };

  if (!settings) return <p>Loading…</p>;
  const toggle = (k) => setSettings((s) => ({ ...s, [k]: !s[k] }));
  const silent = settings.silent_driver_group_monitoring !== false;
  const TOGGLES = [
    ["enabled", "Feature enabled"],
    ["beta_mode", "Beta mode (labels replies)"],
    ["silent_driver_group_monitoring", "Silent driver-group monitoring (recommended)"],
    ["send_driver_group_confirmation", "Reply confirmation in driver group"],
    ["send_reaction", "React 👍 to detected messages"],
    ["ai_fallback_enabled", "AI fallback for unclear messages"],
    ["geocoding_enabled", "Geocode locations to map coordinates"],
    ["semantic_ai_required", "Require AI semantic verification before any status change (fail closed)"],
  ];
  const setNum = (k) => (e) => setSettings((s) => ({ ...s, [k]: e.target.value === "" ? "" : Number(e.target.value) }));

  return (
    <div className="card" style={{ padding: 16, maxWidth: 560 }}>
      <h3>Trailer Tracking settings (Beta)</h3>
      {TOGGLES.map(([k, label]) => {
        // In silent mode the driver-group reply/reaction toggles have no effect —
        // show them disabled so the behavior is not misleading.
        const overridden = silent && (k === "send_driver_group_confirmation" || k === "send_reaction");
        return (
          <label key={k} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", opacity: overridden ? 0.5 : 1 }}>
            <input type="checkbox" checked={!!settings[k]} disabled={overridden} onChange={() => toggle(k)} />
            {label}{overridden ? " (overridden by silent mode)" : ""}
          </label>
        );
      })}
      <p style={{ color: "#94a3b8", fontSize: 12, marginTop: 4 }}>
        Trailer messages are analyzed and registered without replying or reacting in driver groups.
        {silent
          ? " Silent mode is on: nothing is sent back to the driver group. The internal Automatic Updating (Test) group still receives review alerts."
          : " Silent mode is off: the reply/reaction toggles above control driver-group output."}
      </p>
      <div style={{ marginTop: 8 }}>
        <label style={{ display: "block", marginBottom: 4 }}>Automatic Updating (Test) group ID</label>
        <input className="form-input" placeholder={effectiveTestGroup || "using env default"}
          value={settings.automatic_update_test_group_id || ""}
          onChange={(e) => setSettings((s) => ({ ...s, automatic_update_test_group_id: e.target.value }))} />
        <small style={{ color: "#94a3b8" }}>Blank = use configured default ({effectiveTestGroup || "none"}).</small>
      </div>
      <div style={{ marginTop: 8, display: "flex", gap: 12, flexWrap: "wrap" }}>
        <label style={{ display: "block" }}>
          <span style={{ display: "block", fontSize: 12, color: "#94a3b8" }}>Auto-register confidence (default 92)</span>
          <input className="form-input" type="number" min="50" max="100" style={{ width: 120 }}
            value={settings.auto_register_confidence ?? 92} onChange={setNum("auto_register_confidence")} />
        </label>
        <label style={{ display: "block" }}>
          <span style={{ display: "block", fontSize: 12, color: "#94a3b8" }}>Review confidence (default 75)</span>
          <input className="form-input" type="number" min="0" max="100" style={{ width: 120 }}
            value={settings.review_confidence ?? 75} onChange={setNum("review_confidence")} />
        </label>
      </div>
      <p style={{ color: "#94a3b8", fontSize: 12, marginTop: 4 }}>
        AI-verified events at or above the auto-register confidence can change trailer status; between review and
        auto-register they go to Needs Review only; below review confidence they are ignored. If AI verification is
        unavailable, candidates always fail closed to review — no status change.
      </p>
      <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className="btn btn-primary" onClick={save} disabled={busy}>Save settings</button>
        <button className="btn" onClick={backfill} disabled={backfilling} title="Geocode a bounded batch of events missing coordinates">
          {backfilling ? "Geocoding…" : "Geocode missing locations"}
        </button>
      </div>
      <p style={{ color: "#94a3b8", fontSize: 12, marginTop: 8 }}>
        Backfill geocodes a small, bounded batch per click (never on boot) and updates the map for the shared 📍 Live Locations view.
      </p>
    </div>
  );
}


export default SettingsTab;
