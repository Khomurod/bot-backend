import React, { useCallback, useEffect, useState } from "react";
import * as api from "../../api";
import PageFailure from "../../components/PageFailure";
import StatusCard from "./metaCrm/StatusCard";
import CredentialsCard from "./metaCrm/CredentialsCard";

/**
 * Settings → Facebook ↔ Bitrix: the owner enters, tests and saves the Meta
 * Conversions API for CRM credentials here, instead of in the server's
 * environment. Every 15 minutes Wenze reports Facebook leads' Bitrix hiring
 * stages to Meta (Qualified / Converted / Lost) with them.
 * docs/architecture/meta-crm-settings.md.
 *
 * A failed read shows the failure and a retry, never a form drawn from
 * defaults (the Live Location tab's lesson).
 */
export default function MetaCrmTab() {
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [toggling, setToggling] = useState(false);
  const [toggleError, setToggleError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setLoadError(null);
    try {
      const s = await api.getMetaCrmSettings();
      if (!s || typeof s !== "object") throw new Error("The server did not send the Facebook ↔ Bitrix settings.");
      setSettings(s);
    } catch (err) {
      setSettings(null);
      setLoadError(err);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const toggle = async (enabled) => {
    setToggling(true); setToggleError(null);
    try {
      setSettings(await api.setMetaCrmEnabled(enabled));
    } catch (err) { setToggleError(err.message); }
    finally { setToggling(false); }
  };

  if (loading) return <div className="loading"><div className="spinner"></div> Loading…</div>;
  if (!settings) return <PageFailure error={loadError} where="Facebook ↔ Bitrix settings" onRetry={load} />;

  return (
    <div>
      <p style={{ color: "var(--text-muted)", marginTop: 0 }}>
        Tells Facebook which leads become drivers, so ad delivery learns from it. Every 15 minutes Wenze reads the
        hiring-pipeline deals Bitrix changed in the last 7 days and reports each Facebook lead's stage to Meta:
        Interested, Documents, Talking to Dispatch or Sent to Safety → <strong>Qualified</strong>, Hired →{" "}
        <strong>Converted</strong>, Lost → <strong>Lost</strong>. Once per lead per event; no names or phone numbers leave.
      </p>
      {toggleError && <div className="alert alert-error">{toggleError}</div>}
      <StatusCard settings={settings} onToggle={toggle} toggling={toggling} />
      <CredentialsCard settings={settings} onSaved={setSettings} />
    </div>
  );
}
