import React, { useState, useEffect } from "react";
import * as api from "../api";

function getTokenFromPath() {
  const m = window.location.pathname.match(/^\/raise\/([^/?#]+)/);
  return m ? m[1] : "";
}

export default function RaisePublicPage() {
  const token = getTokenFromPath();
  const [info, setInfo] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [step, setStep] = useState("identify"); // identify → verify → pick → done
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  const [teamId, setTeamId] = useState("");
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [code, setCode] = useState("");
  const [drivers, setDrivers] = useState([]);
  const [picks, setPicks] = useState({}); // normName -> boolean (qualifies)

  const flash = (type, text) => setStatus({ type, text });
  const isEmail = info?.contact_type === "email";

  useEffect(() => {
    (async () => {
      if (!token) { setLoadError("Missing link token."); return; }
      try {
        setInfo(await api.getRaisePublicInfo(token));
      } catch (err) {
        setLoadError(err.message);
      }
    })();
  }, [token]);

  const ratePct = (v) => `${Math.round(Number(v) * 100)}¢`;

  const handleRequestCode = async () => {
    if (!teamId) return flash("error", "Please choose your dispatch team.");
    if (!name.trim()) return flash("error", "Please enter your name.");
    if (!contact.trim()) return flash("error", `Please enter your ${isEmail ? "email" : "phone number"}.`);
    setBusy(true);
    setStatus(null);
    try {
      await api.raiseRequestOtp(token, { teamId: Number(teamId), contact: contact.trim() });
      setStep("verify");
      flash("success", `We sent a code to your ${isEmail ? "email" : "phone"}.`);
    } catch (err) {
      flash("error", err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleVerify = async () => {
    if (!code.trim()) return flash("error", "Enter the code you received.");
    setBusy(true);
    setStatus(null);
    try {
      const res = await api.raiseVerifyOtp(token, {
        teamId: Number(teamId), contact: contact.trim(), code: code.trim(),
      });
      setDrivers(res.drivers || []);
      const initial = {};
      (res.drivers || []).forEach((d) => { initial[d.driver_normalized_name] = false; });
      setPicks(initial);
      setStep("pick");
      flash("success", "Verified! Now mark each driver.");
    } catch (err) {
      flash("error", err.message);
    } finally {
      setBusy(false);
    }
  };

  const setPick = (normName, qualifies) => {
    setPicks((prev) => ({ ...prev, [normName]: qualifies }));
  };

  const allMarked = drivers.length > 0 && drivers.every((d) => picks[d.driver_normalized_name] !== undefined);

  const handleSubmit = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const payloadPicks = drivers.map((d) => ({
        driver_normalized_name: d.driver_normalized_name,
        qualified: Boolean(picks[d.driver_normalized_name]),
      }));
      await api.raiseSubmit(token, {
        teamId: Number(teamId), name: name.trim(), contact: contact.trim(), picks: payloadPicks,
      });
      setStep("done");
    } catch (err) {
      flash("error", err.message);
    } finally {
      setBusy(false);
    }
  };

  const wrap = { maxWidth: 560, margin: "40px auto", padding: "0 16px" };

  if (loadError) {
    return (
      <div style={wrap}>
        <div className="card">
          <h2>Link unavailable</h2>
          <p>{loadError}</p>
        </div>
      </div>
    );
  }

  if (!info) {
    return <div className="loading" style={{ minHeight: "60vh" }}><div className="spinner"></div> Loading…</div>;
  }

  return (
    <div style={wrap}>
      <div className="card">
        <h2>💵 Driver Raise Review</h2>
        <p>
          Pay period <b>{info.period_start} → {info.period_end}</b>. Mark which company drivers
          earned <b>{ratePct(info.rate_high)}/mile</b> (instead of {ratePct(info.rate_low)}/mile) for this week.
        </p>

        {status && (
          <div className={`alert alert-${status.type}`} style={{ marginBottom: 16 }}>{status.text}</div>
        )}

        {step === "identify" && (
          <div style={{ display: "grid", gap: 12 }}>
            <div className="form-group">
              <label>Your dispatch team</label>
              <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
                <option value="">— choose your team —</option>
                {info.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>Your name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="First Last" />
            </div>
            <div className="form-group">
              <label>Your {isEmail ? "email" : "phone number"}</label>
              <input
                type={isEmail ? "email" : "tel"}
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                placeholder={isEmail ? "you@company.com" : "+1 555 123 4567"}
              />
            </div>
            <button className="btn btn-primary" onClick={handleRequestCode} disabled={busy}>
              {busy ? "Sending…" : "Send me a code"}
            </button>
          </div>
        )}

        {step === "verify" && (
          <div style={{ display: "grid", gap: 12 }}>
            <div className="form-group">
              <label>Enter the 6-digit code we sent to {contact}</label>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                maxLength={6}
                placeholder="123456"
              />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-primary" onClick={handleVerify} disabled={busy}>
                {busy ? "Checking…" : "Verify"}
              </button>
              <button className="btn btn-ghost" onClick={() => setStep("identify")} disabled={busy}>Back</button>
            </div>
          </div>
        )}

        {step === "pick" && (
          <div>
            <p>For each driver, choose whether they qualify for the raise:</p>
            <div style={{ display: "grid", gap: 8 }}>
              {drivers.map((d) => {
                const v = picks[d.driver_normalized_name];
                return (
                  <div
                    key={d.driver_normalized_name}
                    style={{
                      display: "flex", justifyContent: "space-between", alignItems: "center",
                      gap: 8, padding: "8px 0", borderBottom: "1px solid var(--border, #eee)",
                    }}
                  >
                    <span>{d.driver_name}</span>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button
                        className={`btn btn-sm ${v === true ? "btn-primary" : "btn-ghost"}`}
                        onClick={() => setPick(d.driver_normalized_name, true)}
                      >
                        ✅ {ratePct(info.rate_high)}
                      </button>
                      <button
                        className={`btn btn-sm ${v === false ? "btn-danger" : "btn-ghost"}`}
                        onClick={() => setPick(d.driver_normalized_name, false)}
                      >
                        ❌ {ratePct(info.rate_low)}
                      </button>
                    </div>
                  </div>
                );
              })}
              {drivers.length === 0 && <p>Your team has no assigned drivers. Please contact the admin.</p>}
            </div>
            <button
              className="btn btn-primary"
              style={{ marginTop: 16 }}
              onClick={handleSubmit}
              disabled={busy || !allMarked || drivers.length === 0}
            >
              {busy ? "Submitting…" : "Submit"}
            </button>
            {!allMarked && drivers.length > 0 && (
              <p style={{ color: "#888", marginTop: 8 }}>Mark every driver to enable submit.</p>
            )}
          </div>
        )}

        {step === "done" && (
          <div>
            <h3>✅ Thank you!</h3>
            <p>Your response was recorded and sent to management. You can close this page.</p>
          </div>
        )}
      </div>
    </div>
  );
}
