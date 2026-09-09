import React from "react";

import * as api from "../../../api";

/**
 * One provider: who it is, whether it is answering, and the key — never shown.
 *
 * The key field is always blank on load and its placeholder carries the mask.
 * That is deliberate rather than lazy: rendering `••••abcd` INTO the input
 * makes an operator wonder whether saving the form will write those bullets
 * back as the key. Blank plus "leave empty to keep" has one meaning.
 *
 * Test before save, not after. The button sends whatever is currently typed, so
 * a key is proven while it can still be corrected — the alternative is finding
 * out at the next real call, hours later, in a feature nobody was watching.
 */
const KIND_WORDING = {
  credential: "The key was rejected. Check it and try again.",
  quota: "The key works — but this provider's allowance is spent for now.",
  transient: "The provider is busy or unreachable right now. The key may still be fine.",
  fatal_request: "The key works, but that model name was refused.",
  unknown: "Could not tell what went wrong.",
};

export default function ProviderCard({ provider, onSaved, flash }) {
  const [form, setForm] = React.useState({
    label: provider.label || provider.providerKey,
    enabled: provider.enabled,
    priority: provider.priority,
    isFree: provider.isFree,
    baseUrl: provider.baseUrl || "",
    modelChain: (provider.modelChain || []).join(", "),
    apiKey: "",
  });
  const [testing, setTesting] = React.useState(false);
  const [result, setResult] = React.useState(null);
  const [saving, setSaving] = React.useState(false);

  const set = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));

  const models = form.modelChain.split(",").map((m) => m.trim()).filter(Boolean);

  const save = async () => {
    setSaving(true);
    try {
      await api.updateAiProvider(provider.providerKey, {
        label: form.label,
        enabled: form.enabled,
        priority: Number(form.priority) || 100,
        isFree: form.isFree,
        baseUrl: form.baseUrl || null,
        modelChain: models,
        // Omitted when blank, which is what leaves the stored key alone.
        ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
      });
      set("apiKey", "");
      flash("success", `${form.label} saved.`);
      onSaved();
    } catch (err) {
      flash("error", err?.detail || err?.message || "Could not save.");
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      setResult(await api.testAiProvider(provider.providerKey, {
        apiKey: form.apiKey.trim() || undefined,
        adapter: provider.adapter,
        baseUrl: form.baseUrl,
        model: models[0],
      }));
    } catch (err) {
      setResult({ ok: false, error: err?.detail || err?.message });
    } finally {
      setTesting(false);
    }
  };

  const clearCooldown = async () => {
    try {
      await api.clearAiProviderCooldown(provider.providerKey);
      flash("success", "Back in rotation.");
      onSaved();
    } catch (err) {
      flash("error", err?.detail || err?.message || "Could not clear it.");
    }
  };

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <strong>{provider.label || provider.providerKey}</strong>{" "}
          <span className="badge badge-muted">{provider.adapter}</span>{" "}
          {provider.isFree && <span className="badge">free tier</span>}
          <div style={{ color: "#94a3b8", fontSize: 11 }}>
            <code>{provider.providerKey}</code>
            {provider.apiKeyFromEnv && " · key inherited from the environment"}
            {provider.apiKeyMasked && !provider.apiKeyFromEnv && ` · ${provider.apiKeyMasked}`}
          </div>
        </div>
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => set("enabled", e.target.checked)}
          />
          Enabled
        </label>
      </div>

      {/* A cooldown always says why — the schema refuses one without a reason. */}
      {provider.cooledUntil && (
        <div style={{ marginTop: 8, fontSize: 12, color: "#f59e0b" }}>
          Not being asked right now: {provider.cooldownReason}{" "}
          <button type="button" className="btn btn-ghost btn-sm" onClick={clearCooldown}>
            Put back in rotation
          </button>
        </div>
      )}

      <div className="home-time-form-grid" style={{ marginTop: 10 }}>
        <div className="form-group">
          <label>Priority (1 is tried first)</label>
          <input
            className="form-input" type="number" min={1} max={999}
            value={form.priority} onChange={(e) => set("priority", e.target.value)}
          />
        </div>
        <div className="form-group">
          <label>Base URL</label>
          <input
            className="form-input" value={form.baseUrl}
            placeholder={provider.adapter === "gemini" ? "(not used)" : "https://api.groq.com/openai/v1"}
            onChange={(e) => set("baseUrl", e.target.value)}
          />
        </div>
        <div className="form-group" style={{ gridColumn: "1 / -1" }}>
          <label>Models, in order, comma separated</label>
          <input
            className="form-input" value={form.modelChain}
            onChange={(e) => set("modelChain", e.target.value)}
          />
        </div>
        <div className="form-group" style={{ gridColumn: "1 / -1" }}>
          <label>API key</label>
          <input
            className="form-input" type="password" value={form.apiKey}
            placeholder={provider.apiKeySet
              ? `Leave empty to keep the stored key (${provider.apiKeyMasked})`
              : "No key stored — this provider will inherit the environment"}
            onChange={(e) => set("apiKey", e.target.value)}
          />
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
        <button type="button" className="btn btn-primary btn-sm" disabled={saving} onClick={save}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button" className="btn btn-secondary btn-sm"
          disabled={testing || !models.length} onClick={test}
          title={models.length ? "" : "Add a model to test with"}
        >
          {testing ? "Testing…" : "Test this key"}
        </button>
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
          <input
            type="checkbox" checked={form.isFree}
            onChange={(e) => set("isFree", e.target.checked)}
          />
          Free tier
        </label>
      </div>

      {result && (
        <div style={{ marginTop: 8, fontSize: 12, color: result.ok ? "#22c55e" : "#f59e0b" }}>
          {result.ok
            ? `Answered in ${result.latencyMs}ms — “${result.sample}”`
            : (KIND_WORDING[result.failureKind] || result.error)}
        </div>
      )}
    </div>
  );
}
