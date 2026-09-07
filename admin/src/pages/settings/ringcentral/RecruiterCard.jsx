import React, { useEffect, useState } from "react";
import * as api from "../../../api";
import { KeyField } from "../fields";
import { cleanBitrixUserId } from "./bitrixUserId";

/**
 * One recruiter row.
 *
 * The card answers three questions at a glance, in this order of importance:
 *   1. Can this person's number actually send a lead text?  → the sender badge
 *   2. Which Bitrix user are they?                          → the mapping field
 *   3. Do their credentials still work?                     → Test / Diagnose
 *
 * (1) and (2) are what decide whether a lead assigned to them in Bitrix is
 * texted from THEIR number or falls back to the shared company number, so a
 * broken login is shown as a red badge rather than being left to be discovered
 * from drivers replying to the wrong phone.
 *
 * Split out of RingCentralTab.jsx.
 */

/** Sender state as one badge: the single thing an operator scans this row for. */
function SenderBadge({ recruiter }) {
  if (recruiter.rcAuthError) {
    return (
      <span className="badge badge-inactive" title={recruiter.rcAuthError}>
        ⚠️ Needs RingCentral sign-in
      </span>
    );
  }
  if (!recruiter.canSendSms) {
    return (
      <span className="badge badge-inactive" title="No credentials of their own — leads fall back to the shared number">
        Shared number
      </span>
    );
  }
  return (
    <span
      className="badge badge-active"
      title={recruiter.authMode === "oauth"
        ? "Signed in with RingCentral — texts leads from this number"
        : "JWT stored — texts leads from this number"}
    >
      Sends as self ({recruiter.authMode === "oauth" ? "login" : "JWT"})
    </span>
  );
}

export default function RecruiterCard({ recruiter, onSaved, onDeleted, onMessage, bitrixUsers, loadBitrixUsers }) {
  const [expanded, setExpanded] = useState(false);
  const [form, setForm] = useState({
    name: recruiter.name,
    phoneNumber: recruiter.phone_number,
    bitrixUserId: recruiter.bitrixUserId ?? "",
    jwtToken: "",
    clientId: "",
    clientSecret: "",
  });
  const [useCustom, setUseCustom] = useState(recruiter.usesCustomClient);
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState(null);
  const [testing, setTesting] = useState(false);
  const [diag, setDiag] = useState(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const [connectUrl, setConnectUrl] = useState(null);
  const [smsTo, setSmsTo] = useState("");
  const [smsResult, setSmsResult] = useState(null);
  const [sendingSms, setSendingSms] = useState(false);

  // The automap writes bitrix_user_id straight to the row, so the stored value
  // can change while this card is mounted. `form` is seeded once at mount, so
  // without this the editor would keep showing the pre-mapping value — and
  // save() would send it back. `save()` also only submits the field when it
  // actually differs from what is stored, so the two guards are independent.
  const storedBitrixUserId = recruiter.bitrixUserId ?? "";
  useEffect(() => {
    setForm((f) => (
      String(f.bitrixUserId) === String(storedBitrixUserId)
        ? f
        : { ...f, bitrixUserId: storedBitrixUserId }
    ));
  }, [storedBitrixUserId]);

  // The Bitrix directory is fetched by the parent so every row shares one
  // call; this only tracks whether THIS row asked for it yet.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerBusy, setPickerBusy] = useState(false);

  // "Check Bitrix user" — confirm the typed id is a real person before saving.
  const [bitrixCheck, setBitrixCheck] = useState(null);
  const [checkingBitrix, setCheckingBitrix] = useState(false);

  const checkBitrix = async () => {
    const cleaned = cleanBitrixUserId(form.bitrixUserId);
    if (cleaned.cleared) {
      setBitrixCheck({ ok: false, found: false, message: "Enter a Bitrix user id first." });
      return;
    }
    if (!cleaned.ok) {
      setBitrixCheck({
        ok: false, found: false,
        message: "That is not a numeric Bitrix user id — use the number from the profile URL, e.g. 17.",
      });
      return;
    }
    // Show the cleaned id (a pasted URL becomes just the number) right away.
    if (cleaned.value !== String(form.bitrixUserId).trim()) setField("bitrixUserId", cleaned.value);
    setCheckingBitrix(true); setBitrixCheck(null);
    try { setBitrixCheck({ id: cleaned.value, ...(await api.checkBitrixUser(cleaned.value)) }); }
    catch (err) { setBitrixCheck({ ok: false, found: false, message: err.message }); }
    finally { setCheckingBitrix(false); }
  };

  const openPicker = async () => {
    setPickerBusy(true);
    try {
      const users = await loadBitrixUsers?.();
      // null = the read failed and the page already said why. An empty list is
      // a DIFFERENT answer and has to be said out loud, or this button just
      // looks broken.
      if (!users) return;
      if (!users.length) {
        onMessage?.({
          type: "error",
          text: "Bitrix returned no users for this webhook. Type the id by hand, or add the "
            + '"user" scope to the inbound webhook.',
        });
        return;
      }
      setPickerOpen(true);
    } finally { setPickerBusy(false); }
  };

  const setField = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    // A non-numeric id (a pasted URL, "#17", a typo) must NOT be sent: the
    // server would normalize it to null and clear the mapping while reporting
    // success — the "it won't save" bug. Reject it here with what to type.
    const cleanedId = cleanBitrixUserId(form.bitrixUserId);
    if (!cleanedId.ok) {
      onMessage({
        type: "error",
        text: `"${String(form.bitrixUserId).trim()}" is not a Bitrix user id — use the number `
          + "from the profile URL (e.g. 17), or clear the field.",
      });
      return;
    }
    // A pasted profile URL becomes just its number; reflect that in the field.
    if (cleanedId.value !== String(form.bitrixUserId).trim()) setField("bitrixUserId", cleanedId.value);

    setSaving(true);
    try {
      const payload = {
        name: form.name,
        phoneNumber: form.phoneNumber,
      };
      // Sent ONLY when this form changed it — blank included, because a
      // deliberately emptied field clears the mapping. Sending it
      // unconditionally is how an unrelated name save used to wipe a mapping
      // the automap had just written under this card.
      if (String(cleanedId.value).trim() !== String(storedBitrixUserId).trim()) {
        payload.bitrixUserId = String(cleanedId.value).trim();
      }
      if (form.jwtToken.trim()) payload.jwtToken = form.jwtToken.trim();
      if (useCustom) {
        if (form.clientId.trim()) payload.clientId = form.clientId.trim();
        if (form.clientSecret.trim()) payload.clientSecret = form.clientSecret.trim();
      } else if (recruiter.usesCustomClient) {
        // Switched back to the shared pair — clear the stored custom pair.
        payload.clearClientCreds = true;
      }
      await api.updateRecruiter(recruiter.id, payload);
      setForm((f) => ({ ...f, jwtToken: "", clientId: "", clientSecret: "" }));
      onMessage({ type: "success", text: `${form.name || recruiter.name} saved.` });
      await onSaved();
    } catch (err) { onMessage({ type: "error", text: err.message }); }
    finally { setSaving(false); }
  };

  const candidateCreds = () => ({
    jwtToken: form.jwtToken.trim() || undefined,
    clientId: useCustom ? (form.clientId.trim() || undefined) : undefined,
    clientSecret: useCustom ? (form.clientSecret.trim() || undefined) : undefined,
  });

  const runTest = async () => {
    setTesting(true); setTest(null);
    try { setTest(await api.testRecruiterConnection(recruiter.id, candidateCreds())); }
    catch (err) { setTest({ connected: false, message: err.message }); }
    finally { setTesting(false); }
  };

  const runDiagnose = async () => {
    setDiagnosing(true); setDiag(null);
    try { setDiag(await api.diagnoseRecruiter(recruiter.id, candidateCreds())); }
    catch (err) { setDiag({ ok: false, steps: [{ label: "Diagnostic", ok: false, detail: err.message }] }); }
    finally { setDiagnosing(false); }
  };

  const makeConnectLink = async () => {
    try {
      const { connectUrl: url } = await api.createRecruiterConnectLink({ recruiterId: recruiter.id });
      setConnectUrl(url);
      setExpanded(true);
    } catch (err) { onMessage({ type: "error", text: err.message }); }
  };

  const clearLogin = async () => {
    if (!window.confirm(`Forget ${recruiter.name}'s RingCentral sign-in? Their leads will use the shared number until they sign in again.`)) return;
    try {
      await api.clearRecruiterRingCentralLogin(recruiter.id);
      onMessage({ type: "success", text: `${recruiter.name}'s RingCentral sign-in was removed.` });
      await onSaved();
    } catch (err) { onMessage({ type: "error", text: err.message }); }
  };

  const sendTestSms = async () => {
    setSendingSms(true); setSmsResult(null);
    try { setSmsResult(await api.sendRecruiterTestSms(recruiter.id, { to: smsTo.trim() })); }
    catch (err) { setSmsResult({ sent: false, message: err.message }); }
    finally { setSendingSms(false); }
  };

  const toggleActive = async () => {
    try { await api.updateRecruiter(recruiter.id, { active: !recruiter.active }); await onSaved(); }
    catch (err) { onMessage({ type: "error", text: err.message }); }
  };

  const remove = async () => {
    if (!window.confirm(`Remove recruiter "${recruiter.name}"? Their historical call stats will be unassigned.`)) return;
    try { await api.deleteRecruiter(recruiter.id); await onDeleted(); }
    catch (err) { onMessage({ type: "error", text: err.message }); }
  };

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <strong>{recruiter.name}</strong>
          <span style={{ fontFamily: "monospace", fontSize: 13, color: "#94a3b8" }}>{recruiter.phone_number}</span>
          <span className={`badge ${recruiter.active ? "badge-active" : "badge-inactive"}`}>{recruiter.active ? "Active" : "Inactive"}</span>
          <SenderBadge recruiter={recruiter} />
          <span
            className={`badge ${recruiter.bitrixUserId ? "badge-muted" : "badge-inactive"}`}
            title={recruiter.bitrixUserId
              ? `Leads assigned to Bitrix user ${recruiter.bitrixUserId} are texted from this number`
              : "No Bitrix user mapped — leads assigned to this person cannot be matched"}
          >
            {recruiter.bitrixUserId ? `Bitrix #${recruiter.bitrixUserId}` : "No Bitrix user"}
          </span>
          <span className="badge badge-muted">{recruiter.usesCustomClient ? "Custom app creds" : "Shared app creds"}</span>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button className="btn btn-ghost btn-sm" onClick={makeConnectLink}>Sign-in link</button>
          <button className="btn btn-ghost btn-sm" onClick={runTest} disabled={testing}>{testing ? "Testing…" : "Test connection"}</button>
          <button className="btn btn-ghost btn-sm" onClick={runDiagnose} disabled={diagnosing}>{diagnosing ? "Diagnosing…" : "Diagnose"}</button>
          <button className="btn btn-ghost btn-sm" onClick={() => setExpanded((e) => !e)}>{expanded ? "Close" : "Edit"}</button>
        </div>
      </div>

      {recruiter.rcAuthError && (
        <div style={{ fontSize: 12, marginTop: 8, color: "#f87171" }}>⚠️ {recruiter.rcAuthError}</div>
      )}

      {test && (
        <div style={{ fontSize: 12, marginTop: 8, color: test.connected ? "#22c55e" : "#f87171" }}>
          {test.connected ? "✓" : "✕"} {test.message}
        </div>
      )}

      {diag && (
        <div style={{ marginTop: 10, padding: 10, borderRadius: 8, background: "rgba(148,163,184,0.08)" }}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, color: diag.ok ? "#22c55e" : "#f87171" }}>
            {diag.ok ? "✓ All checks passed" : "✕ Issues found"}
          </div>
          {(diag.steps || []).map((s, idx) => (
            <div key={idx} style={{ fontSize: 12, marginBottom: 4 }}>
              <span style={{ color: s.ok ? "#22c55e" : "#f87171" }}>{s.ok ? "✓" : "✕"}</span>{" "}
              <strong style={{ color: "#cbd5e1" }}>{s.label}:</strong>{" "}
              <span style={{ color: "#94a3b8" }}>{s.detail}</span>
            </div>
          ))}
        </div>
      )}

      {expanded && (
        <div style={{ marginTop: 12, borderTop: "1px solid rgba(148,163,184,0.15)", paddingTop: 12 }}>
          {connectUrl && (
            <div style={{ marginBottom: 12, padding: 10, borderRadius: 8, background: "rgba(34,197,94,0.1)" }}>
              <div style={{ fontSize: 12, color: "#cbd5e1", marginBottom: 4 }}>
                Send this to {recruiter.name}. It expires in 30 minutes and works once.
              </div>
              <input className="form-input" readOnly value={connectUrl} onFocus={(e) => e.target.select()} />
            </div>
          )}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <div className="form-group" style={{ marginBottom: 8 }}>
              <label style={{ display: "block", fontSize: 12, marginBottom: 4 }}>Name</label>
              <input className="form-input" value={form.name} onChange={(e) => setField("name", e.target.value)} />
            </div>
            <div className="form-group" style={{ marginBottom: 8 }}>
              <label style={{ display: "block", fontSize: 12, marginBottom: 4 }}>RingCentral number</label>
              <input className="form-input" value={form.phoneNumber} onChange={(e) => setField("phoneNumber", e.target.value)} />
            </div>
            <div className="form-group" style={{ marginBottom: 8 }}>
              <label style={{ display: "block", fontSize: 12, marginBottom: 4 }}>Bitrix24 user ID</label>
              <input
                className="form-input"
                inputMode="numeric"
                placeholder="e.g. 17"
                value={form.bitrixUserId}
                onChange={(e) => setField("bitrixUserId", e.target.value)}
              />
              {pickerOpen && (bitrixUsers || []).length > 0 ? (
                <select
                  className="form-input"
                  style={{ marginTop: 6 }}
                  value={String(form.bitrixUserId || "")}
                  onChange={(e) => setField("bitrixUserId", e.target.value)}
                >
                  <option value="">— no Bitrix user —</option>
                  {(bitrixUsers || []).map((u) => (
                    <option key={u.id} value={u.id}>
                      #{u.id} · {u.fullName}{u.position ? ` · ${u.position}` : ""}{u.active === false ? " · deactivated" : ""}
                    </option>
                  ))}
                </select>
              ) : (
                <button
                  className="btn btn-ghost btn-sm"
                  style={{ marginTop: 6 }}
                  onClick={openPicker}
                  disabled={pickerBusy || !loadBitrixUsers}
                >
                  {pickerBusy ? "Reading Bitrix…" : "Pick from Bitrix"}
                </button>
              )}
              <button
                className="btn btn-ghost btn-sm"
                style={{ marginTop: 6, marginLeft: 8 }}
                onClick={checkBitrix}
                disabled={checkingBitrix}
              >
                {checkingBitrix ? "Checking…" : "Check Bitrix user"}
              </button>
              {bitrixCheck && (
                <div style={{ fontSize: 12, marginTop: 6, color: bitrixCheck.found ? "#22c55e" : "#f87171" }}>
                  {bitrixCheck.found
                    ? `✓ #${bitrixCheck.user.id} — ${bitrixCheck.user.fullName}`
                      + `${bitrixCheck.user.position ? ` · ${bitrixCheck.user.position}` : ""}`
                      + `${bitrixCheck.user.active === false ? " · deactivated" : ""}`
                    : bitrixCheck.ok
                      ? `✗ No Bitrix user #${bitrixCheck.id} exists in this portal.`
                      : `✗ ${bitrixCheck.message || bitrixCheck.detail || "Could not check this id."}`}
                </div>
              )}
              <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 4, maxWidth: 320 }}>
                Or type it from the Bitrix profile URL:{" "}
                <code>/company/personal/user/<strong>17</strong>/</code>.
                A lead assigned to this Bitrix user is texted from this number.
              </div>
            </div>
          </div>

          <div style={{ marginBottom: 12, padding: 10, borderRadius: 8, background: "rgba(148,163,184,0.06)" }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#cbd5e1", marginBottom: 6 }}>Send a test text from this number</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-start" }}>
              <input
                className="form-input"
                style={{ maxWidth: 220 }}
                placeholder="+1 555 123 4567"
                value={smsTo}
                onChange={(e) => setSmsTo(e.target.value)}
              />
              <button className="btn btn-ghost btn-sm" onClick={sendTestSms} disabled={sendingSms || !smsTo.trim()}>
                {sendingSms ? "Sending…" : "Send test SMS"}
              </button>
            </div>
            {smsResult && (
              <div style={{ fontSize: 12, marginTop: 6, color: smsResult.sent ? "#22c55e" : "#f87171" }}>
                {smsResult.sent ? "✓" : "✕"} {smsResult.message}
              </div>
            )}
          </div>

          <KeyField
            label="JWT Token (this number's own — only needed without a RingCentral sign-in)"
            hint={recruiter.jwtTokenSet ? recruiter.jwtTokenMasked : "not set"}
            value={form.jwtToken}
            onChange={(v) => setField("jwtToken", v)}
          />
          <div className="form-group" style={{ marginBottom: 8 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
              <input type="checkbox" checked={useCustom} onChange={(e) => setUseCustom(e.target.checked)} />
              Use a custom Client ID / Client Secret for this number
            </label>
            <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 4 }}>
              Off = this number authenticates with the shared Client ID/Secret from the credentials card above.
            </div>
          </div>
          {useCustom && (
            <div style={{ paddingLeft: 12, borderLeft: "2px solid rgba(148,163,184,0.25)" }}>
              <KeyField label="Custom Client ID" hint={recruiter.clientIdSet ? recruiter.clientIdMasked : "not set"} value={form.clientId} onChange={(v) => setField("clientId", v)} />
              <KeyField label="Custom Client Secret" hint={recruiter.clientSecretSet ? recruiter.clientSecretMasked : "not set"} value={form.clientSecret} onChange={(v) => setField("clientSecret", v)} />
            </div>
          )}
          {recruiter.oauthConnected && (
            <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 8 }}>
              Signed in with RingCentral
              {recruiter.rcExtensionNumber ? ` as ext. ${recruiter.rcExtensionNumber}` : ""}
              {recruiter.rcTokenRefreshedAt ? ` · login refreshed ${new Date(recruiter.rcTokenRefreshedAt).toLocaleString()}` : ""}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
            <button className="btn btn-primary btn-sm" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
            <button className="btn btn-ghost btn-sm" onClick={toggleActive}>{recruiter.active ? "Deactivate" : "Activate"}</button>
            {recruiter.oauthConnected && (
              <button className="btn btn-ghost btn-sm" onClick={clearLogin}>Forget RingCentral sign-in</button>
            )}
            <button className="btn btn-danger btn-sm" onClick={remove}>Delete</button>
          </div>
        </div>
      )}
    </div>
  );
}

export { SenderBadge };
