import React, { useState } from "react";
import * as api from "../../../api";

const EMPTY = { name: "", phoneNumber: "", bitrixUserId: "", jwtToken: "", clientId: "", clientSecret: "", useCustom: false };

/**
 * Add a recruiter and their number by hand, with the number's own JWT. Opened
 * from a button on Recruiters & Numbers (an always-open card until November
 * 2026); the invite link is the easier way and comes first.
 */
export default function AddRecruiterPanel({ onAdded, onMessage }) {
  const [newRec, setNewRec] = useState(EMPTY);
  const set = (k, v) => setNewRec((n) => ({ ...n, [k]: v }));

  const add = async () => {
    if (!newRec.name.trim() || !newRec.phoneNumber.trim()) {
      onMessage({ type: "error", text: "Recruiter name and phone number are required." });
      return;
    }
    try {
      const payload = { name: newRec.name.trim(), phoneNumber: newRec.phoneNumber.trim() };
      if (newRec.bitrixUserId.trim()) payload.bitrixUserId = newRec.bitrixUserId.trim();
      if (newRec.jwtToken.trim()) payload.jwtToken = newRec.jwtToken.trim();
      if (newRec.useCustom) {
        if (newRec.clientId.trim()) payload.clientId = newRec.clientId.trim();
        if (newRec.clientSecret.trim()) payload.clientSecret = newRec.clientSecret.trim();
      }
      await api.createRecruiter(payload);
      setNewRec(EMPTY);
      await onAdded();
      onMessage({ type: "success", text: "Recruiter added. Use Test connection / Diagnose on the row to verify." });
    } catch (err) { onMessage({ type: "error", text: err.message }); }
  };

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h3 style={{ marginTop: 0 }}>Add Recruiter &amp; Number Manually</h3>
      <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 0 }}>
        Each recruiter has one dedicated RingCentral direct number, and each number has its own
        JWT token. The Client ID/Secret default to the shared pair under{" "}
        <a href="#settings/rc_connection">RingCentral Connection</a>; tick the checkbox to use a
        separate pair for this number.
      </p>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <div className="form-group" style={{ marginBottom: 8 }}>
          <label style={{ display: "block", fontSize: 12, marginBottom: 4 }}>Recruiter name</label>
          <input className="form-input" value={newRec.name} placeholder="Jane Doe" onChange={(e) => set("name", e.target.value)} />
        </div>
        <div className="form-group" style={{ marginBottom: 8 }}>
          <label style={{ display: "block", fontSize: 12, marginBottom: 4 }}>RingCentral number</label>
          <input className="form-input" value={newRec.phoneNumber} placeholder="+1 (470) 480-4679" onChange={(e) => set("phoneNumber", e.target.value)} />
        </div>
        <div className="form-group" style={{ marginBottom: 8 }}>
          <label style={{ display: "block", fontSize: 12, marginBottom: 4 }}>Bitrix24 user ID</label>
          <input className="form-input" inputMode="numeric" placeholder="e.g. 17" value={newRec.bitrixUserId} onChange={(e) => set("bitrixUserId", e.target.value)} />
        </div>
      </div>
      <div className="form-group" style={{ marginBottom: 8 }}>
        <label style={{ display: "block", fontSize: 12, marginBottom: 4 }}>JWT Token (this number's own)</label>
        <input className="form-input" type="password" autoComplete="new-password" value={newRec.jwtToken} placeholder="Paste the JWT for this number's user" onChange={(e) => set("jwtToken", e.target.value)} />
      </div>
      <div className="form-group" style={{ marginBottom: 8 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
          <input type="checkbox" checked={newRec.useCustom} onChange={(e) => set("useCustom", e.target.checked)} />
          Use a custom Client ID / Client Secret for this number
        </label>
      </div>
      {newRec.useCustom && (
        <div style={{ paddingLeft: 12, borderLeft: "2px solid var(--border)", marginBottom: 8 }}>
          <div className="form-group" style={{ marginBottom: 8 }}>
            <label style={{ display: "block", fontSize: 12, marginBottom: 4 }}>Custom Client ID</label>
            <input className="form-input" type="password" autoComplete="new-password" value={newRec.clientId} onChange={(e) => set("clientId", e.target.value)} />
          </div>
          <div className="form-group" style={{ marginBottom: 8 }}>
            <label style={{ display: "block", fontSize: 12, marginBottom: 4 }}>Custom Client Secret</label>
            <input className="form-input" type="password" autoComplete="new-password" value={newRec.clientSecret} onChange={(e) => set("clientSecret", e.target.value)} />
          </div>
        </div>
      )}
      <button className="btn btn-primary btn-sm" onClick={add}>Add recruiter</button>
    </div>
  );
}
