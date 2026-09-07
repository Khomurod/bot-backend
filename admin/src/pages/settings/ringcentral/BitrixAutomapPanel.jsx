import React, { useState } from "react";
import * as api from "../../../api";

/**
 * "Match recruiters to Bitrix users" — the mapping, without the copying.
 *
 * WHY. `bitrix_user_id` on a recruiter row is the only link from a Bitrix lead
 * assignment back to a recruiter, and therefore what decides whose number
 * texts a driver. Filling it in by hand meant opening every Bitrix profile,
 * reading the id out of the URL, and typing it in — per recruiter, and again
 * for each new hire. This reads the directory and proposes the mapping.
 *
 * TWO STEPS ON PURPOSE. The first click only PREVIEWS: nothing is written
 * until the plan is on screen and the operator applies it. Weak matches (a
 * first name and nothing else) are never applied automatically — they are
 * listed with a checkbox, because "Alex" the recruiter and "Alex" in
 * accounting are indistinguishable from here, and a wrong mapping texts a
 * driver from a colleague's phone.
 */
const listStyle = { fontSize: 12, color: "#94a3b8", margin: "2px 0 0 0", paddingLeft: 16 };

function Group({ title, tone = "#cbd5e1", children }) {
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: tone }}>{title}</div>
      {children}
    </div>
  );
}

export default function BitrixAutomapPanel({ onMapped }) {
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState([]);
  const [result, setResult] = useState(null);

  const preview = async () => {
    setBusy(true); setResult(null); setConfirmed([]);
    try { setPlan(await api.automapRecruiterBitrixUsers({})); }
    catch (err) { setPlan({ ok: false, message: err.message }); }
    finally { setBusy(false); }
  };

  const apply = async () => {
    setBusy(true);
    try {
      const applied = await api.automapRecruiterBitrixUsers({ apply: true, confirm: confirmed });
      setResult(applied);
      setPlan(applied);
      if (applied.applied?.length) onMapped?.();
    } catch (err) {
      setResult({ ok: false, message: err.message });
    } finally { setBusy(false); }
  };

  const toggle = (recruiterId) => setConfirmed((prev) => (
    prev.includes(recruiterId) ? prev.filter((id) => id !== recruiterId) : [...prev, recruiterId]
  ));

  const willWrite = (plan?.apply?.length || 0) + confirmed.length;

  return (
    <div style={{ marginTop: 12, padding: 10, borderRadius: 8, background: "rgba(148,163,184,0.08)" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button className="btn btn-ghost btn-sm" onClick={preview} disabled={busy}>
          {busy && !result ? "Reading Bitrix…" : "Match recruiters to Bitrix users"}
        </button>
        {plan?.ok && !result && (
          <button className="btn btn-sm" onClick={apply} disabled={busy || willWrite === 0}>
            {willWrite === 0 ? "Nothing to apply" : `Apply ${willWrite} mapping${willWrite === 1 ? "" : "s"}`}
          </button>
        )}
        <span style={{ fontSize: 12, color: "#64748b" }}>
          Reads the Bitrix user directory. Nothing is written until you apply.
        </span>
      </div>

      {plan && !plan.ok && (
        <div style={{ marginTop: 8, fontSize: 12, color: "#f87171" }}>
          {plan.message || "Could not read the Bitrix user directory."}
          {plan.detail ? <span style={{ color: "#94a3b8" }}> ({plan.detail})</span> : null}
        </div>
      )}

      {plan?.ok && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 12, color: "#94a3b8" }}>
            {plan.bitrixUsers} Bitrix user(s) · {plan.recruiters} recruiter(s)
          </div>

          {result && (
            <Group title={`✓ Mapped ${result.applied?.length || 0} recruiter(s)`} tone="#22c55e">
              <ul style={listStyle}>
                {(result.applied || []).map((e) => (
                  <li key={e.recruiterId}>{e.recruiterName} → Bitrix #{e.bitrixUserId} ({e.bitrixUserName})</li>
                ))}
              </ul>
              {(result.failed || []).length > 0 && (
                <ul style={{ ...listStyle, color: "#f87171" }}>
                  {result.failed.map((e) => (
                    <li key={e.recruiterId}>{e.recruiterName}: {e.error}</li>
                  ))}
                </ul>
              )}
            </Group>
          )}

          {!result && (plan.apply || []).length > 0 && (
            <Group title={`Will map ${plan.apply.length} recruiter(s)`} tone="#22c55e">
              <ul style={listStyle}>
                {plan.apply.map((e) => (
                  <li key={e.recruiterId}>
                    {e.recruiterName} → Bitrix #{e.bitrixUserId} ({e.bitrixUserName})
                    <span style={{ color: "#64748b" }}> · matched by {e.via === "phone" ? "phone number" : "full name"}</span>
                    {e.bitrixUserActive === false && <span style={{ color: "#fbbf24" }}> · that Bitrix user is deactivated</span>}
                  </li>
                ))}
              </ul>
            </Group>
          )}

          {!result && (plan.propose || []).length > 0 && (
            <Group title="Only a first name matched — confirm each one" tone="#fbbf24">
              {plan.propose.map((e) => (
                <label key={e.recruiterId} style={{ display: "block", fontSize: 12, color: "#94a3b8", paddingLeft: 4 }}>
                  <input
                    type="checkbox"
                    checked={confirmed.includes(e.recruiterId)}
                    onChange={() => toggle(e.recruiterId)}
                    style={{ marginRight: 6 }}
                  />
                  {e.recruiterName} → Bitrix #{e.bitrixUserId} ({e.bitrixUserName})
                </label>
              ))}
            </Group>
          )}

          {(plan.ambiguous || []).length > 0 && (
            <Group title="Matched more than one Bitrix user — map these by hand" tone="#fbbf24">
              <ul style={listStyle}>
                {plan.ambiguous.map((e) => (
                  <li key={e.recruiterId}>
                    {e.recruiterName}: {e.candidates.map((c) => `#${c.bitrixUserId} ${c.bitrixUserName}`).join(", ")}
                  </li>
                ))}
              </ul>
            </Group>
          )}

          {(plan.conflicts || []).length > 0 && (
            <Group title="Conflicts — nothing written for these" tone="#f87171">
              <ul style={listStyle}>
                {plan.conflicts.map((e, idx) => (
                  <li key={`${e.recruiterId}-${idx}`}>{e.recruiterName}: {e.reason}</li>
                ))}
              </ul>
            </Group>
          )}

          {(plan.alreadyMapped || []).filter((e) => e.mismatch).length > 0 && (
            <Group title="Already mapped, but the number says otherwise" tone="#fbbf24">
              <ul style={listStyle}>
                {plan.alreadyMapped.filter((e) => e.mismatch).map((e) => (
                  <li key={e.recruiterId}>
                    {e.recruiterName} is mapped to #{e.bitrixUserId}, but their{" "}
                    {e.mismatch.via === "phone" ? "phone number" : "name"} matches #{e.mismatch.bitrixUserId}{" "}
                    ({e.mismatch.bitrixUserName}). Left as is — change it on the row if it is wrong.
                  </li>
                ))}
              </ul>
            </Group>
          )}

          {(plan.unmatched || []).length > 0 && (
            <Group title={`No Bitrix user found for ${plan.unmatched.length} recruiter(s)`}>
              <ul style={listStyle}>
                {plan.unmatched.map((e) => <li key={e.recruiterId}>{e.recruiterName}</li>)}
              </ul>
            </Group>
          )}
        </div>
      )}
    </div>
  );
}
