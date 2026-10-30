import React from "react";

import * as api from "../../../api";

/**
 * The order providers are asked in — first is the primary, every other one a
 * fallback, tried in turn only when the ones above it cannot answer.
 *
 * The owner asked for exactly this (October 2026): "if I put Claude first,
 * Claude is used first, and the others I lined up are the fallbacks". A
 * priority NUMBER on each card could express it, but it made an operator do
 * arithmetic across cards; a list with ↑ ↓ is the order itself. Saving writes
 * the whole order at once, so it is never half-applied.
 *
 * It also says, beside each provider, the two things that would make the order
 * on screen differ from the order Wenze follows: a provider that is switched
 * off, and a paid one skipped by "Free tiers only". Rotate mode makes the order
 * only a starting point, and the card says that too.
 */
function sameOrder(a, b) {
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

export default function ProviderOrderCard({ providers, settings, onSaved, flash }) {
  const saved = React.useMemo(() => providers.map((p) => p.providerKey), [providers]);
  const [order, setOrder] = React.useState(saved);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => { setOrder(saved); }, [saved]);

  const byKey = React.useMemo(
    () => Object.fromEntries(providers.map((p) => [p.providerKey, p])),
    [providers]
  );

  const move = (index, delta) => {
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    [next[index], next[target]] = [next[target], next[index]];
    setOrder(next);
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.setAiProviderOrder(order);
      flash("success", "Provider order saved.");
      onSaved();
    } catch (err) {
      flash("error", err?.detail || err?.message || "Could not save the order.");
    } finally {
      setSaving(false);
    }
  };

  if (providers.length < 2) return null;
  const changed = !sameOrder(order, saved);
  let fallbackNumber = 0;

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <strong>Order of providers</strong>
      <div style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 4 }}>
        The first provider is asked first. If it cannot answer, the next one is
        asked, and so on down the list.
      </div>
      {settings.routingMode === "round_robin" && (
        <div style={{ color: "var(--warning)", fontSize: 12, marginTop: 6 }}>
          “Rotate” is selected above, so this order is only a starting point. Choose
          “Always try them in priority order” for a strict primary and fallbacks.
        </div>
      )}

      <ol style={{ listStyle: "none", padding: 0, margin: "10px 0 0" }}>
        {order.map((key, index) => {
          const p = byKey[key];
          if (!p) return null;
          const skippedFree = settings.freeOnlyMode && !p.isFree;
          const active = p.enabled && !skippedFree;
          let role = "not used";
          if (active) {
            role = fallbackNumber === 0 ? "primary" : `fallback ${fallbackNumber}`;
            fallbackNumber += 1;
          }
          return (
            <li
              key={key}
              style={{
                display: "flex", alignItems: "center", gap: 8, padding: "6px 0",
                borderTop: index ? "1px solid var(--border)" : "none",
                opacity: active ? 1 : 0.6,
              }}
            >
              <span style={{ width: 22, color: "var(--text-muted)" }}>{index + 1}.</span>
              <span style={{ flex: 1 }}>
                <strong>{p.label || key}</strong>{" "}
                <span className={active && role === "primary" ? "badge" : "badge badge-muted"}>{role}</span>
                <span style={{ color: "var(--text-muted)", fontSize: 11 }}>
                  {!p.enabled && " · switched off"}
                  {p.enabled && skippedFree && " · paid — skipped while “Free tiers only” is on"}
                  {p.modelChain?.length > 0 && ` · ${p.modelChain[0]}`}
                </span>
              </span>
              <button
                type="button" className="btn btn-ghost btn-sm" aria-label={`Move ${p.label || key} up`}
                disabled={index === 0} onClick={() => move(index, -1)}
              >
                ↑
              </button>
              <button
                type="button" className="btn btn-ghost btn-sm" aria-label={`Move ${p.label || key} down`}
                disabled={index === order.length - 1} onClick={() => move(index, 1)}
              >
                ↓
              </button>
            </li>
          );
        })}
      </ol>

      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button type="button" className="btn btn-primary btn-sm" disabled={!changed || saving} onClick={save}>
          {saving ? "Saving…" : "Save order"}
        </button>
        {changed && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOrder(saved)}>
            Undo
          </button>
        )}
      </div>
    </div>
  );
}
