import React, { useEffect, useState } from "react";

/**
 * Settings → Safety Approvals → 5. Bitrix stages.
 *
 * When on, the bot follows each candidate's conversation in the recruiting
 * group's General topic and, when it shows the candidate has moved on ("CLH
 * sent", "CLEAN", "Approved"), posts "move <driver> to <stage>?" with a button
 * in the BITRIX TOPIC named here — never in General. Anyone in the group may
 * press it; only then does the deal move in Bitrix. With no open deal and the
 * candidate certain (one name in the post, one phone), the bot creates the
 * contact and deal itself and says so in the topic; otherwise it asks the
 * recruiter there, with the reason.
 *
 * The switch stays disabled until the Bitrix topic is saved (the server
 * refuses it too): the proposals post nowhere else.
 */
export default function HiringStagesCard({
  settings, proposals, crmRecords = [], busy, onToggle, onSaveTopic, onTestTopic,
}) {
  const [topic, setTopic] = useState(settings?.bitrixTopicId ? String(settings.bitrixTopicId) : "");
  useEffect(() => { setTopic(settings?.bitrixTopicId ? String(settings.bitrixTopicId) : ""); }, [settings?.bitrixTopicId]);

  const available = Boolean(settings?.enabled);
  const hasTopic = Boolean(settings?.bitrixTopicId);
  const on = Boolean(settings?.stageProposalsEnabled);
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3 style={{ marginTop: 0 }}>5. Bitrix stages</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        The bot reads each candidate&apos;s conversation in General and, when it shows the candidate has
        reached a later Bitrix stage, posts a <b>Move</b> button in the Bitrix topic below — with the
        driver&apos;s name and a link to the post. Nothing moves in Bitrix until somebody presses it. With no
        open deal, the bot creates the contact and deal itself when the post names one driver and has one
        phone number; otherwise it asks the recruiter, with the reason. SSNs, birth dates and phone numbers
        are removed before AI reads the text.
      </p>
      <div className="form-group">
        <label htmlFor="sa-bitrix-topic">Bitrix topic link or number</label>
        <input id="sa-bitrix-topic" className="form-input" placeholder="https://t.me/c/1234567890/77"
          value={topic} onChange={(e) => setTopic(e.target.value)} disabled={busy} />
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
          {hasTopic ? `Saved: topic #${settings.bitrixTopicId}. ` : "Not saved yet. "}
          Every Bitrix message goes here: proposals, deals created or missing, Move / No results and Bitrix
          errors. Right-click a message in that topic → Copy Message Link, and paste it here.
        </div>
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
        <button type="button" className="btn btn-primary" onClick={() => onSaveTopic(topic)}
          disabled={busy || !settings?.chatId}>Save Bitrix topic</button>
        <button type="button" className="btn btn-ghost" onClick={onTestTopic} disabled={busy || !hasTopic}>
          Send a test message to the Bitrix topic
        </button>
      </div>
      <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input type="checkbox" checked={on}
          disabled={busy || (!on && (!available || !hasTopic))}
          onChange={(e) => onToggle(e.target.checked)} />
        <span>Propose Bitrix stage changes in the Bitrix topic</span>
      </label>
      {!available && (
        <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 6 }}>
          Switch Safety Approvals on first — this reads the messages it captures.
        </div>
      )}
      {available && !hasTopic && (
        <div style={{ fontSize: 13, color: on ? "var(--danger)" : "var(--text-muted)", marginTop: 6 }}>
          {on
            ? "Waiting: save the Bitrix topic — nothing is posted until then, and conversations wait in the queue."
            : "Save the Bitrix topic first."}
        </div>
      )}
      {crmRecords.length > 0 && (
        <table className="data-table" style={{ marginTop: 12 }}>
          <thead><tr><th>When</th><th>Driver</th><th>Created in Bitrix</th></tr></thead>
          <tbody>
            {crmRecords.map((r) => (
              <tr key={`c${r.id}`}>
                <td>{new Date(r.updatedAt).toLocaleString()}</td>
                <td>{r.driverName || "—"}</td>
                <td>{CREATED[r.status] || r.status}
                  {r.status === "created" && !r.dealReused ? ` — deal #${r.dealId}${r.contactReused ? " (existing contact)" : ""}` : ""}
                  {r.lastError && r.status !== "created" ? ` (${r.lastError})` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
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

const CREATED = {
  claimed: "Starting",
  creating_contact: "Creating the contact",
  creating_deal: "Creating the deal",
  created: "Created",
  blocked: "Not created — a person was asked",
  failed: "Bitrix refused",
};
