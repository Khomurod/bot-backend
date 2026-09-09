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

  return (
    <tr style={{ borderTop: "1px solid rgba(148,163,184,0.15)" }}>
      <td style={{ padding: "10px 8px" }}>
        <div>{checkLabel(check.checkKey)}</div>
        <div style={{ color: "#94a3b8", fontSize: 11 }}>
          <code>{check.checkKey}</code> → <code>{check.actionKey}</code>
        </div>
        {check.updatedBy && (
          <div style={{ color: "#94a3b8", fontSize: 11 }}>
            last changed by {check.updatedBy}
          </div>
        )}
      </td>
      <td style={{ padding: "10px 8px", width: 140 }}>
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
      </td>
      <td style={{ padding: "10px 8px", width: 190 }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input
            className="form-input"
            type="number"
            min={1}
            max={500}
            value={cap}
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
      </td>
    </tr>
  );
}

export default function ChecksTab({ checks, busy, setCheckEnabled, preview, loadPreview }) {
  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <strong>What the system may correct by itself</strong>
        <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 4 }}>
          Only checks whose corrected value is <em>already recorded elsewhere in our
          own data</em> can appear here at all — nothing is inferred, averaged or
          guessed. Everything else stays a finding a person reads.
        </div>

        {checks.length === 0 ? (
          <div className="loading" style={{ marginTop: 12 }}>
            <div className="spinner" /> Loading checks…
          </div>
        ) : (
          <div className="table-container" style={{ marginTop: 12 }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <tbody>
                {checks.map((check) => (
                  <CheckRow
                    key={check.checkKey}
                    check={check}
                    busy={busy}
                    onSave={setCheckEnabled}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
          <div>
            <strong>Dry run</strong>
            <div style={{ color: "#94a3b8", fontSize: 12 }}>
              Exactly what enabling these would do right now, writing nothing.
            </div>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={loadPreview}>
            Preview
          </button>
        </div>

        {preview && (
          <div style={{ marginTop: 12, fontSize: 12 }}>
            <div style={{ color: "#94a3b8" }}>
              {preview.summary?.open ?? 0} findings open ·{" "}
              {preview.summary?.eligible ?? 0} would be applied ·{" "}
              {preview.summary?.skipped?.disabled ?? 0} waiting for permission
            </div>
            {(preview.capped || []).map((c) => (
              <div key={c.checkKey} style={{ color: "#f59e0b", marginTop: 6 }}>
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
    </>
  );
}
