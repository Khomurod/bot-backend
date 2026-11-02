import React, { useState } from "react";

/**
 * The super admin: whose Telegram account "Request admin" DMs a link to.
 *
 * Set once, so once it is saved the card is one line with "Change" (November
 * 2026); the full form opens when it is empty or when Change is pressed.
 * Split out of GroupAccessPanel.jsx.
 */
export default function SuperAdminCard({
  savedId, savedLabel, id, label, onIdChange, onLabelChange, onSave, saving,
}) {
  const [editing, setEditing] = useState(false);
  const open = editing || !savedId;

  if (!open) {
    return (
      <div className="card" style={{ marginBottom: 20, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <strong>Super admin:</strong> {savedLabel ? `${savedLabel} (${savedId})` : savedId}
          <span style={{ color: "var(--text-muted)" }}> — "Request admin" DMs them the link.</span>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" aria-expanded={false} onClick={() => setEditing(true)}>Change</button>
      </div>
    );
  }

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <h3>Super admin</h3>
      <p style={{ color: "var(--text-muted)", marginTop: 0 }}>
        Enter the Telegram numeric ID of the super admin. That person must first press <strong>Start</strong> on the Wenze
        Feedback bot. When you tap "Request admin" on a group below, the bot DMs them a link that adds it to the chosen
        group as an admin so it can read every message.
      </p>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div className="form-group">
          <label>Super admin Telegram ID</label>
          <input type="text" value={id} placeholder="e.g. 123456789" onChange={(e) => onIdChange(e.target.value.trim())} />
        </div>
        <div className="form-group">
          <label>Label (optional)</label>
          <input type="text" value={label} placeholder="e.g. Tom" onChange={(e) => onLabelChange(e.target.value)} />
        </div>
        <button
          className="btn btn-primary"
          onClick={async () => { if (await onSave()) setEditing(false); }}
          disabled={saving}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {savedId && (
          <button type="button" className="btn btn-ghost" onClick={() => setEditing(false)}>Cancel</button>
        )}
      </div>
    </div>
  );
}
