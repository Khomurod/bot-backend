import React from "react";

import { checkLabel } from "./labels";

/**
 * Which checks the system may act on by itself.
 *
 * Every row here is off until a person turns it on, and it is a row per check
 * rather than one switch on purpose: "the system may close home-time cycles
 * from recorded evidence" and "the system may change a driver's status" are
 * completely different decisions, and one global toggle would force an operator
 * to accept both to get either.
 *
 * The cap beside each switch is not a performance setting. A check that
 * suddenly wants to change hundreds of rows has almost certainly found a bug in
 * itself rather than hundreds of real problems — over its cap it changes
 * NOTHING and files a serious finding about its own behaviour.
 */

function CheckRow({ check, busy, onSave }) {
  const [cap, setCap] = React.useState(check.maxAutoPerRun);

  // A wrapping row rather than a table row (November 2026): on a phone the
  // switch and the cap used to be cut off to the right; now they drop under
  // the label. The internal keys and who changed it last are under Details.
  return (
    <div style={{ borderTop: "1px solid var(--border)", padding: "10px 4px", display: "flex", flexWrap: "wrap", gap: "8px 16px", alignItems: "center" }}>
      <div style={{ flex: "1 1 260px", minWidth: 0 }}>
        <div>{checkLabel(check.checkKey)}</div>
        <details style={{ fontSize: 11, color: "var(--text-muted)" }}>
          <summary style={{ cursor: "pointer" }}>Details</summary>
          <div><code>{check.checkKey}</code> → <code>{check.actionKey}</code></div>
          {check.updatedBy && <div>last changed by {check.updatedBy}</div>}
        </details>
      </div>
      <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
        <input
          type="checkbox"
          checked={check.autoApplyEnabled}
          disabled={busy}
          onChange={(e) => onSave(check.checkKey, {
            autoApplyEnabled: e.target.checked, maxAutoPerRun: Number(cap) || null,
          })}
        />
        Auto-apply
      </label>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input
          className="form-input"
          type="number"
          min={1}
          max={500}
          value={cap}
          aria-label={`Most changes per run: ${checkLabel(check.checkKey)}`}
          style={{ width: 80 }}
          onChange={(e) => setCap(e.target.value)}
        />
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={busy || Number(cap) === check.maxAutoPerRun}
          onClick={() => onSave(check.checkKey, {
            autoApplyEnabled: check.autoApplyEnabled, maxAutoPerRun: Number(cap) || null,
          })}
        >
          Save cap
        </button>
      </div>
    </div>
  );
}

export default function ChecksTab({ checks, busy, setCheckEnabled, preview, loadPreview }) {
  return (
    <>
      {/* First, as the page's own rule asks: read what enabling would do
          before enabling anything (November 2026; it was at the bottom). */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
          <div>
            <strong>Dry run</strong>
            <div style={{ color: "var(--text-muted)", fontSize: 12 }}>
              Exactly what enabling these would do right now, writing nothing.
            </div>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={loadPreview}>
            Preview
          </button>
        </div>

        {preview && (
          <div style={{ marginTop: 12, fontSize: 12 }}>
            <div style={{ color: "var(--text-muted)" }}>
              {preview.summary?.open ?? 0} findings open ·{" "}
              {preview.summary?.eligible ?? 0} would be applied ·{" "}
              {preview.summary?.skipped?.disabled ?? 0} waiting for permission
            </div>
            {(preview.capped || []).map((c) => (
              <div key={c.checkKey} style={{ color: "var(--warning)", marginTop: 6 }}>
                {checkLabel(c.checkKey)} wants to change {c.wanted} rows against a cap
                of {c.cap} — it would change nothing and report itself instead.
              </div>
            ))}
            <ul style={{ paddingLeft: 18, marginTop: 8 }}>
              {(preview.plan || []).slice(0, 25).map((p) => (
                <li key={p.findingId}>{p.describe}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div className="card">
        <strong>What the system may correct by itself</strong>
        <div style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 4 }}>
          Only checks whose corrected value is <em>already recorded elsewhere in our
          own data</em> can appear here at all — nothing is inferred, averaged or
          guessed. Everything else stays a finding a person reads.
        </div>

        {checks.length === 0 ? (
          <div className="loading" style={{ marginTop: 12 }}>
            <div className="spinner" /> Loading checks…
          </div>
        ) : (
          <div style={{ marginTop: 12 }}>
            {checks.map((check) => (
              <CheckRow
                key={check.checkKey}
                check={check}
                busy={busy}
                onSave={setCheckEnabled}
              />
            ))}
          </div>
        )}
      </div>

    </>
  );
}
