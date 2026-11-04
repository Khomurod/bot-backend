import React from "react";

import * as api from "../../../api";
import StoredValuesCard from "./StoredValuesCard";
import UploadCard from "./UploadCard";
import VersionsCard from "./VersionsCard";

const BOOT_TEXT = {
  loaded: (b) => `This app started with version ${b.version} of the stored values (${b.names.length} setting(s)).`,
  skipped: (b) => `This app started with Coolify's environment only (${b.reason}).`,
  failed: (b) => `This app could NOT read the stored values at start (${b.reason}) and is running on Coolify's environment.`,
  off: () => "APP_SECRETS_OFF is set in Coolify: this app ignores the stored values.",
  "not-run": () => "",
};

/**
 * Settings → System → Secrets: the deployment's settings, stored encrypted in
 * the app instead of in Coolify (docs/architecture/app-secrets.md). Super
 * administrators only — the server refuses everyone else and this screen says so.
 */
export default function SecretsTab() {
  const [view, setView] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [denied, setDenied] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [status, setStatus] = React.useState(null);

  const load = React.useCallback(async () => {
    try {
      setView(await api.getAppSecrets());
      setError(null);
    } catch (err) {
      if (err?.status === 403) setDenied(true);
      else setError(err?.message || "Could not load the secrets.");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  const act = async (question, run, done) => {
    if (!window.confirm(question)) return;
    setBusy(true); setStatus(null);
    try {
      const out = await run();
      setStatus({ type: "success", text: done(out) });
      await load();
    } catch (err) {
      setStatus({ type: "error", text: err.message });
    } finally { setBusy(false); }
  };

  const restartNote = (out) => (out.restarting ? " The app is restarting — reload this page in about a minute." : "");
  const remove = (v) => act(
    `Remove ${v.name}? A new version is saved without it.`,
    () => api.removeAppSecret(v.scope, v.name),
    (out) => `Removed ${v.name} (version ${out.versionId}).${restartNote(out)}`,
  );
  const restore = (v) => act(
    `Make version ${v.id} the one in use? It is saved again as the newest version, and this app restarts.`,
    () => api.restoreAppSecretsVersion(v.id),
    (out) => `Version ${v.id} restored as version ${out.versionId}.${restartNote(out)}`,
  );

  if (loading) return <div className="loading"><div className="spinner"></div> Loading…</div>;
  if (denied) {
    return (
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Secrets</h3>
        <p style={{ marginBottom: 0 }}>Only a super administrator can see or change the deployment's secrets.</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="alert alert-error">
        {error}{" "}
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setLoading(true); load(); }}>Try again</button>
      </div>
    );
  }

  const bootText = (BOOT_TEXT[view.boot?.status] || BOOT_TEXT["not-run"])(view.boot || {});
  return (
    <div>
      <div role="alert" aria-live="polite">
        {status && <div className={`alert alert-${status.type}`} style={{ marginBottom: 12 }}>{status.text}</div>}
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>Secrets</h3>
        <p style={{ color: "var(--text-secondary)", marginTop: 0 }}>
          The tokens, keys and passwords both apps run with, stored encrypted here instead of in Coolify. Coolify keeps
          only <code>DATABASE_URL</code> and <code>INTEGRATION_SECRET_KEY</code>. No value is ever shown again after
          it is saved — only its name and, for long values, its last four characters.
        </p>
        {!view.keyConfigured && (
          <div className="alert alert-warning" style={{ marginBottom: 8 }}>
            <code>INTEGRATION_SECRET_KEY</code> is not set in Coolify, so nothing can be stored yet. Generate one long random
            value, add it to BOTH apps in Coolify (Wenze and the Samsara service), redeploy them, then come back here.
          </div>
        )}
        {view.latest && !view.latest.sameKey && view.keyConfigured && (
          <div className="alert alert-error" style={{ marginBottom: 8 }}>
            The stored values were saved under a different <code>INTEGRATION_SECRET_KEY</code> than this app has now, and
            cannot be opened. Put the previous key back in Coolify.
          </div>
        )}
        {bootText && <p style={{ marginBottom: 0 }}>{bootText}</p>}
        {view.boot?.pinned && (
          <div className="alert alert-warning" style={{ marginTop: 8, marginBottom: 0 }}>
            {view.boot?.status === "off" ? (
              <>
                Both <code>APP_SECRETS_OFF</code> and <code>APP_SECRETS_VERSION</code> are set in Coolify;{" "}
                <code>APP_SECRETS_OFF</code> wins, so nothing stored is loaded. Remove both and redeploy for the newest
                version to load.
              </>
            ) : (
              <>
                <code>APP_SECRETS_VERSION</code> is set in Coolify, so every start loads that version — what you save
                here takes effect only after you remove it from Coolify and redeploy.
              </>
            )}
          </div>
        )}
      </div>
      <UploadCard disabled={!view.keyConfigured || busy} onSaved={() => load()} />
      <StoredValuesCard values={view.values} busy={busy || !view.keyConfigured} onRemove={remove} />
      <VersionsCard
        versions={view.versions}
        latestId={view.latest?.id ?? null}
        inUseId={view.boot?.status === "loaded" ? view.boot.version : null}
        busy={busy || !view.keyConfigured}
        onRestore={restore}
      />
    </div>
  );
}
