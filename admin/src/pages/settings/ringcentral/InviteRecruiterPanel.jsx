import React, { useState } from "react";
import * as api from "../../../api";

/**
 * Invite a recruiter: a one-time sign-in link, so they connect RingCentral as
 * themselves and nobody generates or pastes a JWT. Opened from a button on
 * Recruiters & Numbers (it was an always-open card until November 2026).
 */
export default function InviteRecruiterPanel({ onMessage }) {
  const [inviteName, setInviteName] = useState("");
  const [inviteUrl, setInviteUrl] = useState(null);

  const invite = async () => {
    try {
      const { connectUrl } = await api.createRecruiterConnectLink({ invitedName: inviteName.trim() || undefined });
      setInviteUrl(connectUrl);
      onMessage(null);
    } catch (err) { onMessage({ type: "error", text: err.message }); }
  };

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h3 style={{ marginTop: 0 }}>Invite A Recruiter To Connect RingCentral</h3>
      <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 0 }}>
        The easy way to add someone: send them a link, they sign in to RingCentral as
        themselves, and their number and extension are read from their account — nobody
        has to generate or paste a JWT. If the number is not on the platform yet, the
        recruiter row is created from it.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-start" }}>
        <input
          className="form-input"
          style={{ maxWidth: 260 }}
          placeholder="Their name (optional)"
          value={inviteName}
          onChange={(e) => setInviteName(e.target.value)}
        />
        <button className="btn btn-primary btn-sm" onClick={invite}>Create sign-in link</button>
      </div>
      {inviteUrl && (
        <div style={{ marginTop: 10, padding: 10, borderRadius: 8, background: "var(--success-soft)" }}>
          <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 4 }}>
            Send this link to the recruiter. It expires in 30 minutes and works once.
          </div>
          <input className="form-input" readOnly value={inviteUrl} onFocus={(e) => e.target.select()} />
        </div>
      )}
      <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 10 }}>
        After they connect, set their <strong>Bitrix24 user ID</strong> on their row —
        that is what matches an assigned lead to their number.
      </div>
    </div>
  );
}
