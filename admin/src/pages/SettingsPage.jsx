import React, { Suspense, lazy, useState } from "react";

/**
 * Settings — tab shell. Each tab lives in ./settings/ and is lazy-loaded so
 * its code is fetched only when the tab is opened (smaller initial bundle).
 *
 * Secrets are write-only from the UI: the API returns only a masked "••••abcd"
 * hint and never the raw value. Leaving a key field blank on Save keeps the
 * stored value.
 */

const LocationProvidersTab = lazy(() => import("./settings/LocationProvidersTab"));
const RingCentralTab = lazy(() => import("./settings/RingCentralTab"));
const TelegramGroupsTab = lazy(() => import("./settings/TelegramGroupsTab"));
const GmapsTab = lazy(() => import("./settings/GmapsTab"));
const SafetyEventsTab = lazy(() => import("./settings/SafetyEventsTab"));
const BolPodMonitorTab = lazy(() => import("./settings/BolPodMonitorTab"));

export default function SettingsPage() {
  const [tab, setTab] = useState("location");
  return (
    <div>
      <div className="page-header">
        <h2>⚙️ Settings</h2>
        <p>Integration credentials and configuration for the bot's external services.</p>
      </div>
      <div className="ios-glass ai-tab-bar" style={{ marginBottom: 20 }}>
        <button className={`btn ${tab === "location" ? "btn-primary" : "btn-ghost"} touch-target`} onClick={() => setTab("location")}>📡 Live Location</button>
        <button className={`btn ${tab === "ringcentral" ? "btn-primary" : "btn-ghost"} touch-target`} onClick={() => setTab("ringcentral")}>📞 RingCentral</button>
        <button className={`btn ${tab === "groups" ? "btn-primary" : "btn-ghost"} touch-target`} onClick={() => setTab("groups")}>💬 Telegram Groups</button>
        <button className={`btn ${tab === "gmaps" ? "btn-primary" : "btn-ghost"} touch-target`} onClick={() => setTab("gmaps")}>🗺️ GMaps</button>
        <button className={`btn ${tab === "safety" ? "btn-primary" : "btn-ghost"} touch-target`} onClick={() => setTab("safety")}>🎵 Safety Event Music</button>
        <button className={`btn ${tab === "bolpod" ? "btn-primary" : "btn-ghost"} touch-target`} onClick={() => setTab("bolpod")}>📦 BOL/POD Monitor</button>
      </div>
      <Suspense fallback={<div style={{ padding: 20, color: "#94a3b8" }}>Loading…</div>}>
        {tab === "location" && <LocationProvidersTab />}
        {tab === "ringcentral" && <RingCentralTab />}
        {tab === "groups" && <TelegramGroupsTab />}
        {tab === "gmaps" && <GmapsTab />}
        {tab === "safety" && <SafetyEventsTab />}
        {tab === "bolpod" && <BolPodMonitorTab />}
      </Suspense>
    </div>
  );
}
