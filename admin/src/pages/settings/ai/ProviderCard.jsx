import React from "react";

import * as api from "../../../api";
import ModelChainEditor from "./ModelChainEditor";

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
 *
 * WHERE THIS PROVIDER STANDS in the order is not edited here: the Order of
 * providers card owns it, so a save here never sends a priority and can never
 * undo an order saved there.
 *
 * REMOVE IS NOT "SWITCH OFF". Unticking Enabled keeps the stored key; Remove
 * deletes the provider and its key, which is the only way to get a key out of
 * Wenze once it is no longer used (a rotated or leaked key). It asks first, and
 * says plainly that the provider stops being used until it is added again.
 */
const KIND_WORDING = {
  credential: "The key was rejected. Check it and try again.",
  quota: "The key works — but this provider's allowance is spent for now.",
  transient: "The provider is busy or unreachable right now. The key may still be fine.",
  fatal_request: "The key works, but that model name was refused.",
  unknown: "Could not tell what went wrong.",
};

/** Any model of this provider paused for its own spent allowance right now. */
function hasPausedModel(provider) {
  const now = Date.now();
  return Object.values(provider.modelCooldowns || {})
    .some((entry) => entry?.until && new Date(entry.until).getTime() > now);
}

export default function ProviderCard({ provider, onSaved, flash }) {
  const [form, setForm] = React.useState({
    label: provider.label || provider.providerKey,
    enabled: provider.enabled,
    isFree: provider.isFree,
    baseUrl: provider.baseUrl || "",
    workspaceId: provider.workspaceId || "",
    modelChain: provider.modelChain || [],
    apiKey: "",
  });
  const [testing, setTesting] = React.useState(false);
  const [result, setResult] = React.useState(null);
  const [saving, setSaving] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [refreshNote, setRefreshNote] = React.useState(null);
  const [removing, setRemoving] = React.useState(false);

  const set = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));

  const models = form.modelChain;

  const save = async () => {
    setSaving(true);
    try {
      await api.updateAiProvider(provider.providerKey, {
        label: form.label,
        enabled: form.enabled,
        isFree: form.isFree,
        baseUrl: form.baseUrl || null,
        modelChain: models,
        ...(provider.adapter === "anthropic" ? { workspaceId: form.workspaceId.trim() } : {}),
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

  const remove = async () => {
    const name = form.label || provider.providerKey;
    if (!window.confirm(
      `Remove ${name}? Wenze stops using this provider and its stored key is deleted. `
      + "To use it again, add it back with \u201cAdd provider\u201d.",
    )) return;
    setRemoving(true);
    try {
      await api.deleteAiProvider(provider.providerKey);
      flash("success", `${name} removed.`);
      onSaved();
    } catch (err) {
      flash("error", err?.detail || err?.message || "Could not remove the provider.");
      setRemoving(false);
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
        ...(provider.adapter === "anthropic" ? { workspaceId: form.workspaceId.trim() } : {}),
      }));
    } catch (err) {
      setResult({ ok: false, error: err?.detail || err?.message });
    } finally {
      setTesting(false);
    }
  };

  /**
   * Re-read the provider's own listing. A retired model leaves the chain (a free
   * provider's is replaced one for one); nothing else is added, and the
   * operator's order survives for what still exists.
   * The words below say exactly which — a silent chain change is the failure
   * this exists to prevent.
   */
  const refreshModels = async () => {
    setRefreshing(true);
    setRefreshNote(null);
    try {
      const r = await api.refreshAiProviderModels(provider.providerKey);
      if (!r.ok) {
        setRefreshNote({ ok: false, text: `Could not read the model list: ${r.error}` });
      } else if (r.unverified) {
        setRefreshNote({ ok: false, text: "The provider returned no models, so nothing was changed." });
      } else if (!r.changed) {
        setRefreshNote({ ok: true, text: `${r.modelsFound} models listed; the chain is up to date.` });
      } else {
        const parts = [];
        if (r.retired.length) parts.push(`retired ${r.retired.join(", ")}`);
        if (r.added.length) parts.push(`added ${r.added.join(", ")}`);
        setRefreshNote({ ok: true, text: `Chain updated — ${parts.join("; ")}.` });
        set("modelChain", r.chain);
        onSaved();
      }
    } catch (err) {
      setRefreshNote({ ok: false, text: err?.detail || err?.message || "Could not refresh." });
    } finally {
      setRefreshing(false);
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
          <div style={{ color: "var(--text-muted)", fontSize: 11 }}>
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
      {(provider.cooledUntil || hasPausedModel(provider)) && (
        <div style={{ marginTop: 8, fontSize: 12, color: "var(--warning)" }}>
          {provider.cooledUntil
            ? <>Not being asked right now: {provider.cooldownReason}{" "}</>
            : <>Some models are waiting for their allowance to reset; the others are asked meanwhile.{" "}</>}
          <button type="button" className="btn btn-ghost btn-sm" onClick={clearCooldown}>
            Put back in rotation
          </button>
        </div>
      )}

      {/* The models are the operator's choice, picked from the provider's own
          listing. Saved with the card's Save button. */}
      <ModelChainEditor
        chain={models}
        discovered={provider.discoveredModels || []}
        cooldowns={provider.modelCooldowns || {}}
        onChange={(next) => set("modelChain", next)}
      />
      <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-muted)" }}>
        {provider.discoveredModels?.length > 0 && (
          <>
            {provider.discoveredModels.filter((m) => m.chat).length} usable of{" "}
            {provider.discoveredModels.length} listed
            {provider.modelsRefreshedAt && ` (checked ${new Date(provider.modelsRefreshedAt).toLocaleDateString()})`}
          </>
        )}
        {provider.modelsRefreshError && (
          <span style={{ color: "var(--warning)" }}> · last check failed: {provider.modelsRefreshError}</span>
        )}
      </div>

      <div className="home-time-form-grid" style={{ marginTop: 10 }}>
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

      <details className="collapse-panel" style={{ marginTop: 8 }}>
        <summary style={{ fontSize: 12 }}>Advanced settings</summary>
        <div className="home-time-form-grid" style={{ marginTop: 8 }}>
          <div className="form-group">
            <label>Base URL</label>
            <input
              className="form-input" value={form.baseUrl}
              placeholder={provider.adapter === "gemini" ? "(not used)" : "https://api.groq.com/openai/v1"}
              onChange={(e) => set("baseUrl", e.target.value)}
            />
          </div>
          {provider.adapter === "anthropic" && (
            <div className="form-group">
              <label htmlFor={`workspace-${provider.providerKey}`}>Workspace ID</label>
              <input
                id={`workspace-${provider.providerKey}`} className="form-input" value={form.workspaceId}
                placeholder="wrkspc_… — only for an organization-level key"
                onChange={(e) => set("workspaceId", e.target.value)}
              />
            </div>
          )}
        </div>
        <div style={{ color: "var(--text-muted)", fontSize: 11 }}>
          For a provider Wenze knows, this is filled in automatically.
          Change it only for a custom endpoint.
        </div>
      </details>

      <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
        <button type="button" className="btn btn-primary btn-sm" disabled={saving || removing} onClick={save}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button type="button" className="btn btn-secondary btn-sm" disabled={refreshing} onClick={refreshModels}>
          {refreshing ? "Checking…" : "Refresh models"}
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
        <button
          type="button" className="btn btn-danger btn-sm" style={{ marginLeft: "auto" }}
          disabled={removing || saving} onClick={remove}
        >
          {removing ? "Removing…" : "Remove"}
        </button>
      </div>

      {refreshNote && (
        <div role="status" style={{ marginTop: 8, fontSize: 12, color: refreshNote.ok ? "var(--success)" : "var(--warning)" }}>
          {refreshNote.text}
        </div>
      )}

      {result && (
        <div style={{ marginTop: 8, fontSize: 12, color: result.ok ? "var(--success)" : "var(--warning)" }}>
          {result.ok
            ? `Answered in ${result.latencyMs}ms — “${result.sample}”`
            : (KIND_WORDING[result.failureKind] || result.error)}
        </div>
      )}
    </div>
  );
}
