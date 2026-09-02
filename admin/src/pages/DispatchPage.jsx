import React, { useState } from "react";
import { useDispatchAssistant } from "./dispatch/useDispatchAssistant";
import { useEtaTracking } from "./dispatch/useEtaTracking";
import { AssistantTab } from "./dispatch/AssistantTab";
import { EtaTrackingTab } from "./dispatch/EtaTrackingTab";

/**
 * Dispatch Center — page container.
 *
 * LAYOUT AND WIRING ONLY:
 *
 *   dispatch/helpers.js              PURE chat-id resolution, rate stripping, formatting
 *   dispatch/useDispatchAssistant.js upload/paste, parse, copy, send to Telegram
 *   dispatch/useEtaTracking.js       per-group ETA schedules and global intervals
 *   dispatch/AssistantTab.jsx        the Send Load UI
 *   dispatch/EtaTrackingTab.jsx      the ETA configuration UI
 *   dispatch/ToggleSwitch.jsx        the accessible on/off control
 *
 * The two tabs are two hooks because they are two unrelated jobs sharing only
 * this page's status banner: one parses a document and sends a single message,
 * the other configures recurring ETA delivery.
 *
 * Both tabs' hooks mount on load, not on tab switch, which is deliberate — the
 * ETA row count is visible from the first tab's banner if a load fails, and the
 * group list the Send Load tab needs is fetched once.
 *
 * The status banner is owned here so the two hooks cannot leave two
 * contradictory messages on screen at once.
 */
export default function DispatchPage() {
  const [activeTab, setActiveTab] = useState("assistant");
  const [message, setMessage] = useState(null);

  const assistant = useDispatchAssistant(setMessage);
  const eta = useEtaTracking(setMessage);

  return (
    <div>
      <div className="page-header">
        <h2>🚛 Dispatch Center</h2>
        <p>Upload a rate confirmation to create dispatch notes and send them to drivers.</p>
      </div>

      {message && (
        <div className={`alert alert-${message.type}`}>
          {message.text}
        </div>
      )}

      <div style={{ display: "flex", gap: "10px", marginBottom: "20px", flexWrap: "wrap" }}>
        <button
          type="button"
          className={`btn ${activeTab === "assistant" ? "btn-primary" : "btn-ghost"}`}
          onClick={() => setActiveTab("assistant")}
        >
          📄 Send Load
        </button>
        <button
          type="button"
          className={`btn ${activeTab === "testing" ? "btn-primary" : "btn-ghost"}`}
          onClick={() => setActiveTab("testing")}
        >
          ⚙️ ETA Tracking
        </button>
      </div>

      {activeTab === "assistant"
        ? <AssistantTab {...assistant} />
        : <EtaTrackingTab {...eta} />}
    </div>
  );
}
