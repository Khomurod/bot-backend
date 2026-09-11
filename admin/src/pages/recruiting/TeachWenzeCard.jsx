import React from "react";

import * as api from "../../api";

/**
 * Teaching Wenze what it may tell a candidate.
 *
 * The shape of this screen IS the safety property. You type a sentence, Wenze
 * says back what it believes that means, and nothing is in use until you agree.
 * A candidate quoted a wrong pay rate is a real problem for a real person, so
 * there is deliberately no way to type-and-apply in one motion.
 *
 * Nothing is ever deleted. A rate that changes supersedes the old one, which
 * stays with the dates it was true, because "what were we telling candidates in
 * August" gets asked after a dispute.
 */
const KIND_LABEL = {
  fact: "Wenze may say this",
  boundary: "Wenze will never say this",
  correction: "A correction, which overrides the rest",
};

const STATUS_LABEL = {
  proposed: "Waiting for you",
  active: "In use",
  superseded: "Replaced",
  rejected: "Turned down",
  retired: "Out of use",
};

function Entry({ entry, onConfirm, onReject, onRetire, busy }) {
  const [reason, setReason] = React.useState("");
  const waiting = entry.status === "proposed";
  return (
    <div
      style={{
        border: "1px solid rgba(148,163,184,0.25)",
        borderLeft: waiting ? "3px solid #eab308" : "1px solid rgba(148,163,184,0.25)",
        borderRadius: 8, padding: "10px 12px", marginBottom: 8,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 320px", minWidth: 0 }}>
          <div><strong>{entry.statement}</strong></div>
          {entry.understoodAs && (
            <div className="muted" style={{ marginTop: 4 }}>
              Wenze understood: <em>{entry.understoodAs}</em>
            </div>
          )}
          <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>
            {KIND_LABEL[entry.kind] || entry.kind} · {entry.topic} · {STATUS_LABEL[entry.status] || entry.status}
            {entry.confirmedBy && ` · confirmed by ${entry.confirmedBy}`}
            {entry.rejectedReason && ` · ${entry.rejectedReason}`}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "flex-start", flexWrap: "wrap" }}>
          {waiting && (
            <>
              <button type="button" className="btn btn-sm btn-primary" disabled={busy}
                onClick={() => onConfirm(entry)}>
                Yes, use this
              </button>
              <input
                type="text" placeholder="why not?" value={reason}
                onChange={(e) => setReason(e.target.value)}
                style={{ width: 140 }}
              />
              <button type="button" className="btn btn-sm" disabled={busy}
                onClick={() => onReject(entry, reason)}>
                No
              </button>
            </>
          )}
          {entry.status === "active" && (
            <button type="button" className="btn btn-sm" disabled={busy}
              onClick={() => onRetire(entry)} title="Stop using this. It is kept, not deleted.">
              Stop using
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function TeachWenzeCard({ flash }) {
  const [data, setData] = React.useState({ entries: [], summary: {} });
  const [statement, setStatement] = React.useState("");
  const [reading, setReading] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);

  const load = React.useCallback(async () => {
    try {
      setData(await api.getRecruitingKnowledge());
      setError(null);
    } catch (err) {
      setError(err.message || "Could not load what Wenze knows.");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  async function teach() {
    if (!statement.trim()) return;
    setBusy(true);
    try {
      const out = await api.teachWenze(statement.trim());
      setReading(out);
      setStatement("");
      await load();
    } catch (err) {
      flash?.("error", err.message || "Could not read that.");
    } finally {
      setBusy(false);
    }
  }

  async function act(fn, entry, ...args) {
    setBusy(true);
    try {
      await fn(entry.id, ...args);
      setReading(null);
      await load();
      flash?.("success", "Saved.");
    } catch (err) {
      flash?.("error", err.message || "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="card"><h3>🎓 Teach Wenze</h3><p>Loading…</p></div>;

  const waiting = data.entries.filter((e) => e.status === "proposed");
  const inUse = data.entries.filter((e) => e.status === "active");
  const past = data.entries.filter((e) => !["proposed", "active"].includes(e.status));

  return (
    <div className="card">
      <h3>🎓 Teach Wenze</h3>
      <p className="muted">
        Tell Wenze something about the offer in your own words. It will say back what it
        thinks you mean, and nothing reaches a candidate until you agree.
      </p>
      {error && <p className="error">{error}</p>}

      <textarea
        rows={2}
        placeholder="Starting today, company driver pay is 77 CPM instead of 70 CPM."
        value={statement}
        onChange={(e) => setStatement(e.target.value)}
        style={{ width: "100%" }}
      />
      <button type="button" className="btn btn-primary" disabled={busy || !statement.trim()}
        onClick={teach} style={{ marginTop: 6 }}>
        {busy ? "Reading…" : "Tell Wenze"}
      </button>

      {reading && (
        <div className="alert alert-warning" style={{ marginTop: 12 }}>
          <strong>Wenze understood:</strong> {reading.understoodAs}
          {reading.replaces && (
            <div style={{ marginTop: 4 }}>
              This would replace: <em>{reading.replaces.statement}</em>
            </div>
          )}
          <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>
            Nothing has changed yet. Confirm it below to put it into use.
          </div>
        </div>
      )}

      {waiting.length > 0 && (
        <>
          <h4 style={{ marginTop: 18, marginBottom: 6 }}>Waiting for you ({waiting.length})</h4>
          {waiting.map((e) => (
            <Entry key={e.id} entry={e} busy={busy}
              onConfirm={(x) => act(api.confirmRecruitingKnowledge, x)}
              onReject={(x, r) => act(api.rejectRecruitingKnowledge, x, r)}
              onRetire={(x) => act(api.retireRecruitingKnowledge, x)} />
          ))}
        </>
      )}

      <h4 style={{ marginTop: 18, marginBottom: 6 }}>In use ({inUse.length})</h4>
      {inUse.length === 0
        ? <p className="muted">Nothing yet. Wenze will only use the standard message until you teach it something.</p>
        : inUse.map((e) => (
          <Entry key={e.id} entry={e} busy={busy}
            onConfirm={(x) => act(api.confirmRecruitingKnowledge, x)}
            onReject={(x, r) => act(api.rejectRecruitingKnowledge, x, r)}
            onRetire={(x) => act(api.retireRecruitingKnowledge, x)} />
        ))}

      {past.length > 0 && (
        <details style={{ marginTop: 14 }}>
          <summary className="muted">
            No longer used ({past.length}) — kept so you can see what was said and when
          </summary>
          <div style={{ marginTop: 8 }}>
            {past.map((e) => (
              <Entry key={e.id} entry={e} busy={busy}
                onConfirm={() => {}} onReject={() => {}} onRetire={() => {}} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
