/**
 * /questions intro screens: welcome, employee details (with the conditional
 * dispatch-team dropdown), and the shared status card (closed / duplicate /
 * stale / error states).
 */
import { useState } from "react";

export function SosStatusCard({ emoji, title, text, actions = [], error = "" }) {
  return (
    <div className="sos-card sos-center">
      <div className="sos-emoji" aria-hidden="true">{emoji}</div>
      <h1>{title}</h1>
      <p>{text}</p>
      {error ? <div className="sos-error" role="alert">{error}</div> : null}
      {actions.length > 0 && (
        <div className="sos-btn-row">
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              className={`sos-btn ${a.primary ? "sos-btn--primary" : "sos-btn--ghost"}`}
              onClick={a.onClick}
              disabled={a.disabled}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function SosWelcome({ t, meta, metaError, savedToken, busy, error, onStart, onViewResult }) {
  return (
    <div className="sos-card">
      <div className="sos-emoji" aria-hidden="true">🚚✨</div>
      <h1>{t.welcomeTitle}</h1>
      <p>{t.welcomeText}</p>
      <div className="sos-note">🔒 {t.welcomePrivacy}</div>
      {error ? <div className="sos-error" role="alert">{error}</div> : null}
      {metaError ? <div className="sos-error" role="alert">{t.errorTitle}</div> : null}
      <div className="sos-btn-row">
        <button
          type="button"
          className="sos-btn sos-btn--primary sos-btn--block"
          onClick={onStart}
          disabled={!meta || busy}
        >
          {meta ? t.start : t.loading}
        </button>
      </div>
      {savedToken && (
        <div className="sos-btn-row">
          <button type="button" className="sos-btn sos-btn--ghost sos-btn--block" onClick={onViewResult} disabled={busy}>
            {t.viewMyResult}
          </button>
        </div>
      )}
    </div>
  );
}

export function SosDetails({ t, lang, meta, busy, error, onBack, onContinue }) {
  const [fullName, setFullName] = useState("");
  const [department, setDepartment] = useState("");
  const [dispatchTeamId, setDispatchTeamId] = useState("");
  const [validation, setValidation] = useState("");

  const departments = meta?.departments || [];
  const teams = meta?.dispatchTeams || [];
  const isDispatch = department === "dispatch";

  function handleContinue() {
    if (fullName.trim().length < 3) return setValidation(t.nameRequired);
    if (!department) return setValidation(t.departmentRequired);
    if (isDispatch && !dispatchTeamId) return setValidation(t.teamRequired);
    setValidation("");
    return onContinue({ fullName: fullName.trim(), department, dispatchTeamId });
  }

  return (
    <div className="sos-card">
      <h1>{t.detailsTitle}</h1>
      <div className="sos-field">
        <label className="sos-label" htmlFor="sos-name">{t.fullName}</label>
        <input
          id="sos-name"
          className="sos-input"
          type="text"
          value={fullName}
          placeholder={t.fullNamePlaceholder}
          autoComplete="name"
          maxLength={120}
          onChange={(e) => setFullName(e.target.value)}
        />
      </div>
      <div className="sos-field">
        <label className="sos-label" htmlFor="sos-dept">{t.department}</label>
        <select
          id="sos-dept"
          className="sos-select"
          value={department}
          onChange={(e) => { setDepartment(e.target.value); setDispatchTeamId(""); }}
        >
          <option value="">{t.departmentPlaceholder}</option>
          {departments.map((d) => (
            <option key={d.key} value={d.key}>{d.label[lang]}</option>
          ))}
        </select>
      </div>
      {isDispatch && (
        <div className="sos-field">
          <label className="sos-label" htmlFor="sos-team">{t.dispatchTeam}</label>
          <select
            id="sos-team"
            className="sos-select"
            value={dispatchTeamId}
            onChange={(e) => setDispatchTeamId(e.target.value)}
          >
            <option value="">{t.dispatchTeamPlaceholder}</option>
            {teams.map((team) => (
              <option key={team.id} value={team.id}>{team.name}</option>
            ))}
          </select>
        </div>
      )}
      {(validation || error) && <div className="sos-error" role="alert">{validation || error}</div>}
      <div className="sos-btn-row">
        <button type="button" className="sos-btn sos-btn--ghost" onClick={onBack} disabled={busy}>{t.back}</button>
        <button type="button" className="sos-btn sos-btn--primary" onClick={handleContinue} disabled={busy}>
          {busy ? t.loading : t.continue}
        </button>
      </div>
    </div>
  );
}
