import React from "react";

/**
 * Per-recruiter auto-reply templates.
 *
 * ONE OPTIONAL MESSAGE PER RECRUITER — not a second schedule. When Bitrix
 * assigns a lead to a recruiter who has written one, the driver gets that text,
 * sent from that recruiter's own RingCentral number, with `{rep_name}` reading
 * as their name. Leave a box empty and that recruiter's leads use the global
 * time-rule / fallback message above, exactly as before.
 *
 * The list is whatever the server returns — driven by the active `recruiters`
 * rows — so Sofia, Kimberly, Jaime and anyone added later appear here without a
 * code change.
 */
export function RecruiterMessagesSection({
  recruiterMessages,
  setRecruiterTemplate,
  focusRecruiter,
  recruiterRefs,
  previewTarget,
}) {
  if (!recruiterMessages?.length) {
    return (
      <div className="card" style={{ marginBottom: 16, padding: 16 }}>
        <h3 style={{ marginTop: 0 }}>Recruiter messages</h3>
        <p style={{ fontSize: 13, color: "#94a3b8", margin: 0 }}>
          No active recruiters yet. Add them under <strong>Settings → RingCentral</strong>;
          each one can then have their own lead message here.
        </p>
      </div>
    );
  }

  return (
    <div style={{ marginBottom: 16 }}>
      <h3>Recruiter messages</h3>
      <p style={{ fontSize: 13, color: "#94a3b8", marginTop: 0 }}>
        Optional. When Bitrix assigns a lead to one of these recruiters, their message is
        used and sent from their own number. <strong>Leave a box empty to use the time
        rules above.</strong> <code>{"{rep_name}"}</code> renders as that recruiter&apos;s name.
      </p>

      {recruiterMessages.map((entry, index) => (
        <div
          key={entry.recruiter_id}
          className="card"
          style={{
            marginBottom: 12,
            padding: 16,
            outline: previewTarget.kind === "recruiter" && previewTarget.index === index
              ? "1px solid #6366f1"
              : undefined,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
            <strong style={{ fontSize: 15 }}>{entry.recruiter_name}</strong>
            {entry.active === false && (
              <span className="badge" style={{ background: "rgba(148,163,184,0.2)" }}>inactive</span>
            )}
            {entry.bitrix_user_id == null && (
              <span style={{ fontSize: 12, color: "#f59e0b" }}>
                Not mapped to a Bitrix user — leads can never be assigned to them.
              </span>
            )}
            {entry.message_template
              ? <span className="badge badge-active">custom message</span>
              : <span style={{ fontSize: 12, color: "#94a3b8" }}>using the time rules</span>}
          </div>

          <textarea
            ref={(el) => { recruiterRefs.current[index] = el; }}
            className="form-input"
            rows={3}
            placeholder={`Leave empty to use the time rules for ${entry.recruiter_name}'s leads…`}
            value={entry.message_template || ""}
            onFocus={() => focusRecruiter(index)}
            onChange={(e) => setRecruiterTemplate(index, e.target.value)}
          />
        </div>
      ))}
    </div>
  );
}
