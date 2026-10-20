import React from "react";

/**
 * Settings → Safety Approvals → Bitrix stages in General.
 *
 * When on, the bot follows each candidate's conversation in the recruiting
 * group's General topic and, when it shows the candidate has moved on ("CLH
 * sent", "CLEAN", "Approved"), replies there with "move <driver> to <stage>?"
 * and a button. Anyone in the group may press it; only then does the deal move
 * in Bitrix. With no deal found, it asks the recruiter who posted the
 * candidate to create one.
 */
export default function HiringStagesCard({ settings, proposals, busy, onToggle }) {
  const available = Boolean(settings?.enabled);
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3 style={{ marginTop: 0 }}>5. Bitrix stages in General</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        The bot reads each candidate&apos;s conversation in General and, when it shows the candidate has
        reached a later Bitrix stage, replies with a <b>Move</b> button. Nothing changes in Bitrix until
        somebody in the group presses it. With no deal found, the recruiter who posted the candidate is
        asked to create one. SSNs, birth dates and phone numbers are removed before AI reads the text.
      </p>
      <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input type="checkbox" checked={Boolean(settings?.stageProposalsEnabled)}
          disabled={busy || (!available && !settings?.stageProposalsEnabled)}
          onChange={(e) => onToggle(e.target.checked)} />
        <span>Propose Bitrix stage changes in General</span>
      </label>
      {!available && (
        <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 6 }}>
          Switch Safety Approvals on first — this reads the messages it captures.
        </div>
      )}
      {proposals.length > 0 && (
        <table className="data-table" style={{ marginTop: 12 }}>
          <thead><tr><th>When</th><th>Driver</th><th>Proposal</th><th>Result</th></tr></thead>
          <tbody>
            {proposals.map((p) => (
              <tr key={p.id}>
                <td>{new Date(p.createdAt).toLocaleString()}</td>
                <td>{p.driverName || p.dealTitle || "—"}</td>
                <td>{p.kind === "create_deal"
                  ? `No deal — asked to create (${p.toStageName})`
                  : `${p.fromStageName || "?"} → ${p.toStageName}`}</td>
                <td>{RESULT[p.status] || p.status}{p.decidedByName ? ` — ${p.decidedByName}` : ""}
                  {p.lastError && p.status !== "applied" ? ` (${p.lastError})` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const RESULT = {
  pending: "Waiting for a button press",
  applying: "Being applied",
  applied: "Moved",
  declined: "Declined",
  superseded: "Replaced by a newer proposal",
  stale: "Not moved — the deal had changed",
  unsent: "Could not be posted",
};
