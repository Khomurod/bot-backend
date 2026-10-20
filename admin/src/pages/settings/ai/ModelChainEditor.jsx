import React from "react";

/**
 * The models one provider is asked for, in order — chosen by the operator.
 *
 * The first model is asked first; the next is asked only if it fails. Models
 * are picked from what the provider itself listed at the last check, so a
 * typo cannot become a model that fails every call. An id can still be typed
 * for a provider whose listing is incomplete or a custom endpoint.
 *
 * Replaces a comma-separated text box (owner, October 2026: "I must be able to
 * choose the models myself"). Wenze's daily check no longer adds models to a
 * chain chosen here; it only removes one the provider has retired.
 */
function freeLabel(model) {
  if (model.free === "free") return " — free";
  if (model.free === "paid") return " — paid";
  return "";
}

export default function ModelChainEditor({ chain, discovered = [], onChange }) {
  const [pick, setPick] = React.useState("");
  const [typed, setTyped] = React.useState("");

  const available = discovered
    .filter((m) => m.chat && !chain.includes(m.id))
    .sort((a, b) => a.id.localeCompare(b.id));

  const move = (index, delta) => {
    const target = index + delta;
    if (target < 0 || target >= chain.length) return;
    const next = [...chain];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };
  const remove = (index) => onChange(chain.filter((_, i) => i !== index));
  const add = (id) => {
    const model = String(id || "").trim();
    if (!model || chain.includes(model)) return;
    onChange([...chain, model]);
  };

  return (
    <div style={{ marginTop: 8 }}>
      <label style={{ fontSize: 12, color: "#94a3b8" }}>
        Models, in order — the first is asked first, the rest are fallbacks
      </label>
      {chain.length === 0 ? (
        <div style={{ fontSize: 12, color: "#f59e0b", marginTop: 4 }}>
          No models — this provider has nothing to ask. Add one below.
        </div>
      ) : (
        <ol style={{ margin: "4px 0 0", paddingLeft: 20, fontSize: 12 }}>
          {chain.map((model, index) => (
            <li key={model} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <code style={{ flex: 1 }}>{model}</code>
              <button
                type="button" className="btn btn-ghost btn-sm" aria-label={`Move ${model} up`}
                disabled={index === 0} onClick={() => move(index, -1)}
              >
                ↑
              </button>
              <button
                type="button" className="btn btn-ghost btn-sm" aria-label={`Move ${model} down`}
                disabled={index === chain.length - 1} onClick={() => move(index, 1)}
              >
                ↓
              </button>
              <button
                type="button" className="btn btn-ghost btn-sm" aria-label={`Remove ${model}`}
                onClick={() => remove(index)}
              >
                ✕
              </button>
            </li>
          ))}
        </ol>
      )}

      <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
        {available.length > 0 && (
          <>
            <select
              className="form-select" value={pick} aria-label="Model to add"
              onChange={(e) => setPick(e.target.value)} style={{ maxWidth: 320 }}
            >
              <option value="">Choose a model to add…</option>
              {available.map((m) => (
                <option key={m.id} value={m.id}>{m.id}{freeLabel(m)}</option>
              ))}
            </select>
            <button
              type="button" className="btn btn-secondary btn-sm" disabled={!pick}
              onClick={() => { add(pick); setPick(""); }}
            >
              Add
            </button>
          </>
        )}
        <input
          className="form-input" value={typed} placeholder="…or type a model id"
          aria-label="Model id to add" style={{ maxWidth: 240 }}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); add(typed); setTyped(""); }
          }}
        />
        <button
          type="button" className="btn btn-ghost btn-sm" disabled={!typed.trim()}
          onClick={() => { add(typed); setTyped(""); }}
        >
          Add typed
        </button>
      </div>
    </div>
  );
}
