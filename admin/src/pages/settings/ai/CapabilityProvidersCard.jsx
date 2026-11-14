import React from "react";

import * as api from "../../../api";

/**
 * Settings → AI → AI Providers → "Providers for one task".
 *
 * The owner, 14 November 2026: some AI tasks are kept to the providers the
 * owner chooses — reading a candidate's CDL photo first ("only Claude", "only
 * the free ones", "Gemini, then Claude"). For each such task this card holds
 * an ordered list: the first provider is asked first; an answer it is not sure
 * of goes to the next one. A task marked as needing a choice reads NOTHING
 * until at least one provider is chosen — the card says so in red.
 *
 * Beside each provider it says what would stop it being asked anyway:
 * switched off, paid while "Free tiers only" is on, no key, or — for a task
 * that sends pictures — no model that can see one. The list narrows who is
 * asked; it never overrides those.
 */
function sameList(a, b) {
  return (a || []).length === (b || []).length && (a || []).every((k, i) => k === b[i]);
}

function ProviderNotes({ provider, task, freeOnlyMode }) {
  const notes = [];
  if (!provider.enabled) notes.push("switched off");
  if (!provider.hasKey) notes.push("no key");
  if (freeOnlyMode && !provider.isFree) notes.push("paid — skipped while “Free tiers only” is on");
  if (task.needsVision && !provider.canSee) notes.push("none of its models can read a picture");
  return notes.length ? <span className="muted" style={{ fontSize: 11 }}> · {notes.join(" · ")}</span> : null;
}

function TaskProviders({ task, providers, freeOnlyMode, onSaved, flash }) {
  const saved = task.order;
  const [order, setOrder] = React.useState(saved || []);
  const [adding, setAdding] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  React.useEffect(() => { setOrder(saved || []); }, [saved]);

  const byKey = Object.fromEntries(providers.map((p) => [p.providerKey, p]));
  const others = providers.filter((p) => !order.includes(p.providerKey));
  const required = task.providerChoice === "required";
  const changed = saved === null ? order.length > 0 : !sameList(order, saved);

  const move = (index, delta) => {
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    [next[index], next[target]] = [next[target], next[index]];
    setOrder(next);
  };
  const save = async (next) => {
    setSaving(true);
    try {
      await api.setAiCapabilityProviders(task.key, next);
      flash?.("success", `${task.label}: providers saved.`);
      onSaved();
    } catch (err) {
      flash?.("error", err?.detail || err?.message || "Could not save the providers.");
    } finally {
      setSaving(false);
    }
  };

  let status;
  if (saved === null) status = <span className="muted">Follows the order of providers above.</span>;
  else if (!saved.length) {
    status = <span style={{ color: "var(--danger)" }}>No provider chosen — nothing is read.</span>;
  } else status = <span>Asked of: {saved.map((k) => byKey[k]?.label || k).join(" → ")}</span>;

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px", marginTop: 8 }}>
      <strong>{task.label}</strong>
      {!task.aiEnabled && <span className="muted" style={{ fontSize: 12 }}> · switched off in AI Tasks</span>}
      <div style={{ fontSize: 13, marginTop: 2 }}>{status}</div>

      <ol aria-label={`Providers for ${task.label}`} style={{ listStyle: "none", padding: 0, margin: "8px 0 0" }}>
        {order.map((key, index) => {
          const p = byKey[key] || { providerKey: key, label: key, enabled: false, hasKey: false };
          return (
            <li key={key} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
              <span style={{ width: 22, color: "var(--text-muted)" }}>{index + 1}.</span>
              <span style={{ flex: 1 }}>
                <strong>{p.label}</strong>
                <ProviderNotes provider={p} task={task} freeOnlyMode={freeOnlyMode} />
              </span>
              <button type="button" className="btn btn-ghost btn-sm" aria-label={`Move ${p.label} up`}
                disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
              <button type="button" className="btn btn-ghost btn-sm" aria-label={`Move ${p.label} down`}
                disabled={index === order.length - 1} onClick={() => move(index, 1)}>↓</button>
              <button type="button" className="btn btn-ghost btn-sm" aria-label={`Remove ${p.label}`}
                onClick={() => setOrder(order.filter((k) => k !== key))}>✕</button>
            </li>
          );
        })}
      </ol>

      {others.length > 0 && (
        <div style={{ display: "flex", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
          <select className="form-input" style={{ maxWidth: 260 }} aria-label={`Add a provider to ${task.label}`}
            value={adding} onChange={(e) => setAdding(e.target.value)}>
            <option value="">Add a provider…</option>
            {others.map((p) => <option key={p.providerKey} value={p.providerKey}>{p.label}</option>)}
          </select>
          <button type="button" className="btn btn-ghost btn-sm" disabled={!adding}
            onClick={() => { setOrder([...order, adding]); setAdding(""); }}>Add</button>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
        <button type="button" className="btn btn-primary btn-sm" disabled={!changed || saving} onClick={() => save(order)}>
          {saving ? "Saving…" : "Save providers"}
        </button>
        {changed && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOrder(saved || [])}>Undo</button>
        )}
        {!required && saved !== null && (
          <button type="button" className="btn btn-ghost btn-sm" disabled={saving} onClick={() => save(null)}>
            Use the order above again
          </button>
        )}
      </div>
    </div>
  );
}

export default function CapabilityProvidersCard({ flash }) {
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState(null);

  const load = React.useCallback(async () => {
    try {
      setData(await api.getAiCapabilityProviders());
      setError(null);
    } catch (err) {
      setError(err?.message || "Could not load the providers for each task.");
    }
  }, []);
  React.useEffect(() => { load(); }, [load]);

  if (error) return <div className="card" style={{ marginBottom: 12 }}><p className="error">{error}</p></div>;
  if (!data || !data.capabilities?.length) return null;

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <strong>Providers for one task</strong>
      <div style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 4 }}>
        These tasks are asked only of the providers listed here, first one first. When a provider is not sure
        of its answer, the next one is asked; when nobody is sure, nothing is changed.
      </div>
      {data.capabilities.map((task) => (
        <TaskProviders key={task.key} task={task} providers={data.providers || []}
          freeOnlyMode={data.freeOnlyMode === true} onSaved={load} flash={flash} />
      ))}
    </div>
  );
}
