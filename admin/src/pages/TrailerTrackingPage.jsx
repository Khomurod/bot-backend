import React, { useState, useCallback } from "react";
import { TABS } from "./trailerTracking/trackingChrome";
import TrailerListTab from "./trailerTracking/TrailerListTab";
import ImportTab from "./trailerTracking/ImportTab";
import EventsTab from "./trailerTracking/EventsTab";
import UnidentifiedTab from "./trailerTracking/UnidentifiedTab";
import PlannedTab from "./trailerTracking/PlannedTab";
import SettingsTab from "./trailerTracking/SettingsTab";
import TrailerDrawer from "./trailerTracking/TrailerDrawer";

// Trailer Tracking (Beta) — the operational monitoring feature. SEPARATE from
// the Trailer Department (rental and asset management, /trailers); do not merge
// them. This file owns only the tab shell, the toast, and the detail drawer's
// open state; each tab lives in ./trailerTracking.
//
// NOTE: the standalone trailer map tab was removed in the follow-up. Trailers now
// render inside the shared "📍 Live Locations" section. This page is for the
// list, import, events, unidentified review, edit, and settings only — no map.

export default function TrailerTrackingPage() {
  const [tab, setTab] = useState("list");
  const [openId, setOpenId] = useState(null);
  const [toast, setToast] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  const flash = useCallback((type, message) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 4000);
  }, []);

  const bumpReload = useCallback(() => setReloadKey((k) => k + 1), []);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <h1>🚚 Trailer Tracking <span style={{ fontSize: 13, color: "#f59e0b" }}>(Beta)</span></h1>
      </div>
      {toast && (
        <div className={`toast ${toast.type}`} style={{
          padding: "8px 14px", borderRadius: 8, marginBottom: 12,
          background: toast.type === "error" ? "#ef444422" : "#22c55e22",
          color: toast.type === "error" ? "#ef4444" : "#22c55e",
        }}>{toast.message}</div>
      )}
      <div style={{ display: "flex", gap: 4, borderBottom: "1px solid #33415533", marginBottom: 16, flexWrap: "wrap" }}>
        {TABS.map((t) => (
          <button key={t.key} className={`nav-item ${tab === t.key ? "active" : ""}`}
            style={{ borderBottom: tab === t.key ? "2px solid #6366f1" : "2px solid transparent", borderRadius: 0 }}
            onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "list" && <TrailerListTab onOpen={setOpenId} flash={flash} reloadKey={reloadKey} />}
      {tab === "import" && <ImportTab flash={flash} />}
      {tab === "events" && <EventsTab flash={flash} onOpen={setOpenId} />}
      {tab === "planned" && <PlannedTab flash={flash} />}
      {tab === "unidentified" && <UnidentifiedTab flash={flash} />}
      {tab === "settings" && <SettingsTab flash={flash} />}

      {openId && <TrailerDrawer id={openId} onClose={() => setOpenId(null)} flash={flash} onChanged={bumpReload} />}
    </div>
  );
}
