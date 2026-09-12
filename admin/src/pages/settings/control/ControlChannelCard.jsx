import React from "react";

import * as api from "../../../api";
import RememberedAnswers from "./RememberedAnswers";

/**
 * Answering Wenze in Telegram — the switch, the limits, and the allow-list.
 *
 * The screen is built around the one thing that can go wrong badly. A Telegram
 * group contains whoever was ever added to it, so "who may be obeyed" is not a
 * detail in a settings page — it is the only thing between somebody's "yes" in
 * a group chat and a change to the fleet. It is therefore the largest block on
 * the card, it takes a numeric id and refuses a username, and the last operator
 * cannot be removed.
 */
function Operators({ operators, onAdd, onRemove, busy }) {
  const [id, setId] = React.useState("");
  const [label, setLabel] = React.useState("");

  return (
    <div style={{ marginTop: 18 }}>
      <strong>Who Wenze obeys</strong>
      <div className="muted" style={{ marginTop: 4, marginBottom: 10 }}>
        Only these people can answer a question in Telegram. Being in the group is not enough.
      </div>

      {operators.length === 0 && (
        <div className="muted" style={{ marginBottom: 10 }}>
          ⚠ Nobody is on the list — no reply in Telegram will be acted on.
        </div>
      )}

      {operators.map((op) => (
        <div
          key={op.telegramUserId}
          style={{
            display: "flex", gap: 10, alignItems: "center",
            borderTop: "1px solid rgba(148,163,184,0.2)", padding: "8px 0",
          }}
        >
          <div style={{ flex: "1 1 auto", minWidth: 0 }}>
            <strong>{op.label || "Operator"}</strong>
            <div className="muted" style={{ fontSize: 12 }}>{op.telegramUserId}</div>
          </div>
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy || operators.length <= 1}
            title={operators.length <= 1 ? "At least one person must stay on the list." : "Remove"}
            onClick={() => onRemove(op.telegramUserId)}
          >
            Remove
          </button>
        </div>
      ))}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
        <input
          type="text"
          inputMode="numeric"
          placeholder="Telegram user id (a number)"
          value={id}
          onChange={(e) => setId(e.target.value)}
          style={{ flex: "1 1 200px" }}
        />
        <input
          type="text"
          placeholder="Name (optional)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          style={{ flex: "1 1 160px" }}
        />
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy || !id.trim()}
          onClick={async () => {
            await onAdd({ telegramUserId: id.trim(), label: label.trim() || null });
            setId("");
            setLabel("");
          }}
        >
          Add
        </button>
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
        Not a username — a numeric id. The person can get theirs from @userinfobot.
      </div>
    </div>
  );
}

export default function ControlChannelCard({ flash }) {
  const [state, setState] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);

  const load = React.useCallback(async () => {
    try {
      setState(await api.getControlSettings());
      setError(null);
    } catch (err) {
      setError(err.message || "Could not load the control channel settings.");
    }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  const save = async (patch) => {
    setBusy(true);
    try {
      const settings = await api.updateControlSettings(patch);
      setState((s) => ({ ...s, settings }));
      flash?.("success", "Saved.");
    } catch (err) {
      flash?.("error", err.message || "Could not save.");
    } finally {
      setBusy(false);
    }
  };

  if (error) return <div className="card"><div className="muted">{error}</div></div>;
  if (!state) return <div className="card"><div className="muted">Loading…</div></div>;

  const { settings, operators = [], replies = {}, knowledge = [] } = state;

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3 style={{ marginTop: 0 }}>Answering Wenze in Telegram</h3>
      <div className="muted" style={{ marginBottom: 12 }}>
        When Wenze finds something it could fix but has not been told it may, it asks in the
        notifications group. Reply to that message — <em>yes</em>, <em>no</em> and why, or
        <em> later</em> — and it acts on your answer.
      </div>

      <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          type="checkbox"
          checked={settings.enabled !== false}
          disabled={busy}
          onChange={(e) => save({ enabled: e.target.checked })}
        />
        <span>Ask questions in Telegram</span>
      </label>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 14 }}>
        <label style={{ flex: "1 1 180px" }}>
          <div>Most questions at once</div>
          <input
            type="number" min={1} max={20} disabled={busy}
            defaultValue={settings.maxQuestionsPerPass}
            onBlur={(e) => save({ maxQuestionsPerPass: Number(e.target.value) })}
            style={{ width: "100%" }}
          />
        </label>
        <label style={{ flex: "1 1 180px" }}>
          <div>Hours before asking again</div>
          <input
            type="number" min={1} max={720} disabled={busy}
            defaultValue={settings.repeatAfterHours}
            onBlur={(e) => save({ repeatAfterHours: Number(e.target.value) })}
            style={{ width: "100%" }}
          />
        </label>
        <label style={{ flex: "1 1 180px" }}>
          <div>Times it may ask &ldquo;why?&rdquo;</div>
          <input
            type="number" min={0} max={3} disabled={busy}
            defaultValue={settings.clarifyLimit}
            onBlur={(e) => save({ clarifyLimit: Number(e.target.value) })}
            style={{ width: "100%" }}
          />
          <div className="muted" style={{ fontSize: 11 }}>
            When an answer is not clear, or a &ldquo;no&rdquo; has no reason. Zero means it
            never comes back with a follow-up.
          </div>
        </label>
      </div>

      <Operators
        operators={operators}
        busy={busy}
        onAdd={async (payload) => {
          setBusy(true);
          try {
            await api.addControlOperator(payload);
            await load();
            flash?.("success", "Added.");
          } catch (err) {
            flash?.("error", err.message || "Could not add that person.");
          } finally {
            setBusy(false);
          }
        }}
        onRemove={async (telegramUserId) => {
          setBusy(true);
          try {
            await api.removeControlOperator(telegramUserId);
            await load();
            flash?.("success", "Removed.");
          } catch (err) {
            flash?.("error", err.message || "Could not remove that person.");
          } finally {
            setBusy(false);
          }
        }}
      />

      <RememberedAnswers
        memories={knowledge}
        busy={busy}
        onForget={async (id) => {
          setBusy(true);
          try {
            await api.forgetControlAnswer(id);
            await load();
            flash?.("success", "Forgotten. Wenze will ask about this again.");
          } catch (err) {
            flash?.("error", err.message || "Could not forget that answer.");
          } finally {
            setBusy(false);
          }
        }}
      />

      {replies.available && (
        <div className="muted" style={{ fontSize: 12, marginTop: 14 }}>
          {replies.last7d} answer(s) in the last 7 days
          {replies.refused > 0 && ` · ${replies.refused} reply(ies) from people not on the list were ignored`}
        </div>
      )}
    </div>
  );
}
