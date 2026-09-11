import React from "react";

import * as api from "../../../api";

/**
 * When the recruiting team works, and whether Wenze answers when they do not.
 *
 * TWO SWITCHES, DELIBERATELY NOT ONE. A company can record its hours without
 * yet letting Wenze speak — useful on its own, and it means turning the feature
 * on is a separate, conscious act rather than a side effect of filling in a
 * schedule.
 *
 * The screen says what would happen RIGHT NOW, in words, above everything else.
 * "Mon-Fri 08:00-18:00" is a schedule; "the office is shut and Wenze would
 * answer a candidate who texted now" is the thing an administrator is actually
 * deciding about, and it is the sentence they can check against reality.
 */
const DAYS = [
  { n: 1, label: "Mon" }, { n: 2, label: "Tue" }, { n: 3, label: "Wed" },
  { n: 4, label: "Thu" }, { n: 5, label: "Fri" }, { n: 6, label: "Sat" },
  { n: 7, label: "Sun" },
];

const STATUS_LABEL = {
  active: "Wenze may answer",
  handed_off: "A person took it back",
  stopped: "Stopped",
};

function WindowRow({ win, onChange, onRemove }) {
  const toggleDay = (n) => {
    const days = win.days.includes(n) ? win.days.filter((d) => d !== n) : [...win.days, n].sort();
    onChange({ ...win, days });
  };
  return (
    <div style={{
      display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap",
      padding: "8px 0", borderBottom: "1px solid rgba(148,163,184,0.15)",
    }}>
      <div style={{ display: "flex", gap: 2 }}>
        {DAYS.map((d) => (
          <button
            key={d.n} type="button"
            className={`btn btn-sm${win.days.includes(d.n) ? " btn-primary" : ""}`}
            style={{ minWidth: 40 }}
            onClick={() => toggleDay(d.n)}
          >
            {d.label}
          </button>
        ))}
      </div>
      <input
        type="time" value={win.start} aria-label="Starts"
        onChange={(e) => onChange({ ...win, start: e.target.value })}
      />
      <span className="muted">to</span>
      <input
        type="time" value={win.end} aria-label="Ends"
        onChange={(e) => onChange({ ...win, end: e.target.value })}
      />
      <button type="button" className="btn btn-sm" onClick={onRemove}>Remove</button>
    </div>
  );
}

export default function WorkingHoursCard({ flash }) {
  const [data, setData] = React.useState(null);
  const [windows, setWindows] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const payload = await api.getRecruitingHours();
      setData(payload);
      setWindows(payload.settings.windows || []);
    } catch (err) {
      flash?.("error", err.message || "Could not load the recruiting hours");
    } finally {
      setLoading(false);
    }
  }, [flash]);

  React.useEffect(() => { load(); }, [load]);

  const save = async (patch) => {
    setBusy(true);
    try {
      const payload = await api.saveRecruitingHours(patch);
      setData((prev) => ({ ...prev, ...payload }));
      if (payload.settings?.windows) setWindows(payload.settings.windows);
      flash?.("success", "Saved");
      await load();
    } catch (err) {
      // The server names the field it refused, so the message points somewhere.
      flash?.("error", err.message || "Could not save");
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (phone, status) => {
    setBusy(true);
    try {
      await api.setRecruitingConversationStatus(phone, status);
      await load();
    } catch (err) {
      flash?.("error", err.message || "Could not update the conversation");
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="card"><h3>Recruiting hours</h3><p className="muted">Loading…</p></div>;
  if (!data) return null;

  const { settings, now, summary, conversations = [] } = data;

  return (
    <div className="card">
      <h3>Recruiting hours &amp; after-hours answering</h3>

      {/* What would happen this minute, before any of the controls. */}
      <div style={{
        padding: "10px 12px", borderRadius: 8, marginBottom: 12,
        background: now.aiWouldAnswer ? "rgba(34,197,94,0.12)" : "rgba(148,163,184,0.12)",
      }}>
        <strong>
          {now.open
            ? "The office is open right now — a recruiter answers."
            : "The office is closed right now."}
        </strong>
        <div className="muted" style={{ marginTop: 4 }}>
          {now.localTime && `Local time ${now.localTime}. `}
          {now.aiWouldAnswer
            ? "Wenze would answer a candidate who texted now, using only what you have approved."
            : "Wenze would not answer; a candidate would wait for a recruiter."}
        </div>
        <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>{summary}</div>
      </div>

      <label style={{ display: "block", marginBottom: 10 }}>
        Time zone{" "}
        <input
          type="text" defaultValue={settings.timezone} disabled={busy}
          onBlur={(e) => e.target.value !== settings.timezone && save({ timezone: e.target.value })}
          style={{ width: 220 }}
        />
      </label>

      <h4 style={{ marginBottom: 4 }}>Working hours</h4>
      <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
        With no windows at all, Wenze treats the office as always open and never answers anybody.
      </p>
      {/*
        Keyed by position. Safe here because WindowRow holds no state of its own
        — every value it shows comes from the `win` prop — so a removal that
        shifts the list re-renders correctly rather than stranding a stale input.
      */}
      {windows.map((win, i) => (
        <WindowRow
          key={i} win={win}
          onChange={(next) => setWindows(windows.map((w, j) => (j === i ? next : w)))}
          onRemove={() => setWindows(windows.filter((_, j) => j !== i))}
        />
      ))}
      <div style={{ display: "flex", gap: 8, margin: "10px 0" }}>
        <button
          type="button" className="btn btn-sm" disabled={busy}
          onClick={() => setWindows([...windows, { days: [1, 2, 3, 4, 5], start: "08:00", end: "18:00" }])}
        >
          Add a window
        </button>
        <button type="button" className="btn btn-sm btn-primary" disabled={busy}
          onClick={() => save({ windows })}>
          Save hours
        </button>
      </div>

      <h4 style={{ marginBottom: 4 }}>When the office is closed</h4>
      <label style={{ display: "block", marginBottom: 8 }}>
        <input
          type="checkbox" checked={settings.aiAfterHoursEnabled} disabled={busy}
          onChange={(e) => save({ aiAfterHoursEnabled: e.target.checked, windows })}
        />{" "}
        Let Wenze continue the conversation as the assigned recruiter
      </label>
      <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
        Wenze can only state what you have approved under <strong>Teach Wenze</strong>. It never
        promises, approves, waives, hires or sets a start date — a draft that tries is refused whole
        and the candidate gets one line saying a recruiter will follow up.
      </p>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 12 }}>
        <label>
          Stop after{" "}
          <input
            type="number" min={0} max={20} defaultValue={settings.maxRepliesPerConversation}
            disabled={busy} style={{ width: 70 }}
            onBlur={(e) => Number(e.target.value) !== settings.maxRepliesPerConversation
              && save({ maxRepliesPerConversation: Number(e.target.value) })}
          />{" "}
          replies to one candidate
        </label>
        <label>
          Never text between{" "}
          <input
            type="time" defaultValue={settings.quietStartLocal} disabled={busy}
            onBlur={(e) => e.target.value !== settings.quietStartLocal
              && save({ quietStartLocal: e.target.value })}
          />{" "}
          and{" "}
          <input
            type="time" defaultValue={settings.quietEndLocal} disabled={busy}
            onBlur={(e) => e.target.value !== settings.quietEndLocal
              && save({ quietEndLocal: e.target.value })}
          />
        </label>
      </div>

      <h4 style={{ marginBottom: 4 }}>Conversations Wenze is carrying</h4>
      {conversations.length === 0 && <p className="muted">None yet.</p>}
      {conversations.map((c) => (
        <div key={c.driverPhone} style={{
          display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap",
          padding: "6px 0", borderBottom: "1px solid rgba(148,163,184,0.15)",
        }}>
          <div>
            <strong>{c.leadName || c.driverPhone}</strong>
            <div className="muted" style={{ fontSize: 12 }}>
              {STATUS_LABEL[c.status] || c.status} · {c.repliesSent} reply/replies
              {c.refusals > 0 && ` · ${c.refusals} draft(s) refused`}
              {c.lastRefusalReason && ` · last refusal: ${c.lastRefusalReason}`}
              {c.stopReason && ` · ${c.stopReason}`}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {c.status === "active" ? (
              <button type="button" className="btn btn-sm" disabled={busy}
                onClick={() => setStatus(c.driverPhone, "stopped")}>
                Stop Wenze here
              </button>
            ) : (
              <button type="button" className="btn btn-sm" disabled={busy}
                onClick={() => setStatus(c.driverPhone, "active")}>
                Let Wenze resume
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
