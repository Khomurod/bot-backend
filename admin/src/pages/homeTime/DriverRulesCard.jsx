import React, { useCallback, useEffect, useState } from "react";
import * as api from "../../api";

/**
 * Home Time → Settings & Alerts → drivers' own home-time rules.
 *
 * The company policy is 28 days on the road, then at most 4 days home. Some
 * drivers have their own arrangement ("3 weeks on the road, 3 days home"); a
 * rule set here replaces either number for that driver — until a date, if one
 * is given — when Wenze decides whether they came home early or overstayed.
 *
 * "Show the old Bitrix exceptions" lists what the old pipeline-33 cards
 * carried (allowed days, home until, Agreed), matched to drivers by name, so
 * the ones that still apply can be added here. Nothing is imported by itself.
 */
const EMPTY = { groupId: "", roadDays: "", homeDays: "", validUntil: "", note: "" };

export default function DriverRulesCard() {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [old, setOld] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  const load = useCallback(async () => {
    try { setData(await api.getPolicyExceptions()); } catch (err) { setMessage(err.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const run = async (fn, done) => {
    setBusy(true); setMessage(null);
    try { await fn(); if (done) setMessage(done); } catch (err) { setMessage(err.message); } finally { setBusy(false); }
  };
  const save = () => run(async () => { await api.savePolicyException(form); setForm(EMPTY); await load(); }, "Rule saved.");
  const remove = (id) => run(async () => { await api.removePolicyException(id); await load(); }, "Rule removed.");
  const showOld = () => run(async () => setOld(await api.previewBitrixExceptions()));

  if (!data) return <div className="card" style={{ marginBottom: 20 }}>{message || "Loading drivers' rules…"}</div>;
  const policy = data.policy || { roadDays: 28, homeDays: 4 };
  const exceptions = Array.isArray(data.exceptions) ? data.exceptions : [];
  const groups = Array.isArray(data.groups) ? data.groups : [];
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <h3>Drivers&apos; own home-time rules</h3>
      <p className="home-time-muted" style={{ marginTop: 0 }}>
        Company policy: {policy.roadDays} days on the road, then at most {policy.homeDays} days home. A rule here
        replaces either number for one driver when Wenze decides whether they came home early or overstayed.
      </p>
      {exceptions.length === 0 ? <p className="home-time-muted">No driver has an own rule.</p> : (
        <table className="data-table">
          <thead><tr><th>Driver</th><th>Road days</th><th>Home days</th><th>Until</th><th>Note</th><th /></tr></thead>
          <tbody>
            {exceptions.map((e) => (
              <tr key={e.id}>
                <td>{e.groupName}</td>
                <td>{e.roadDays ?? `${policy.roadDays} (policy)`}</td>
                <td>{e.homeDays ?? `${policy.homeDays} (policy)`}</td>
                <td>{e.validUntil || "—"}</td>
                <td>{e.note || ""}</td>
                <td><button className="btn btn-ghost btn-sm" onClick={() => remove(e.id)} disabled={busy}>Remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end", marginTop: 12 }}>
        <label style={{ fontSize: 12 }}>Driver
          <select aria-label="Driver for the rule" className="form-input" value={form.groupId} onChange={set("groupId")} disabled={busy}>
            <option value="">Choose…</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.driverName ? `${g.driverName} — ${g.name}` : g.name}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 12 }}>Days on the road
          <input aria-label="Days on the road" className="form-input" type="number" min="1" style={{ width: 90 }} value={form.roadDays} onChange={set("roadDays")} disabled={busy} />
        </label>
        <label style={{ fontSize: 12 }}>Days at home
          <input aria-label="Days at home" className="form-input" type="number" min="0" style={{ width: 90 }} value={form.homeDays} onChange={set("homeDays")} disabled={busy} />
        </label>
        <label style={{ fontSize: 12 }}>Until (optional)
          <input aria-label="Rule until" className="form-input" type="date" value={form.validUntil} onChange={set("validUntil")} disabled={busy} />
        </label>
        <label style={{ fontSize: 12, flex: 1, minWidth: 160 }}>Note
          <input aria-label="Rule note" className="form-input" value={form.note} onChange={set("note")} disabled={busy} />
        </label>
        <button className="btn btn-primary" onClick={save} disabled={busy || !form.groupId}>Save rule</button>
      </div>
      <div style={{ marginTop: 12 }}>
        <button className="btn btn-ghost btn-sm" onClick={showOld} disabled={busy}>Show the old Bitrix exceptions</button>
        {message && <span style={{ fontSize: 12, marginLeft: 8 }}>{message}</span>}
      </div>
      {Array.isArray(old) && (old.length === 0 ? <p className="home-time-muted">No card in pipeline 33 carries an exception.</p> : (
        <table className="data-table" style={{ marginTop: 8 }}>
          <thead><tr><th>Bitrix card</th><th>Allowed days</th><th>Home until</th><th>Agreed</th><th>Driver here</th><th /></tr></thead>
          <tbody>
            {old.map((c) => (
              <tr key={c.dealId}>
                <td>{c.title}</td><td>{c.allowDays ?? "—"}</td><td>{c.homeUntil || "—"}</td><td>{c.agreed ? "yes" : ""}</td>
                <td>{c.groupName || "no match"}</td>
                <td>{c.groupId && (
                  <button className="btn btn-ghost btn-sm" disabled={busy}
                    onClick={() => setForm({ ...EMPTY, groupId: String(c.groupId), homeDays: c.allowDays ?? "", validUntil: c.homeUntil || "", note: `From Bitrix card ${c.dealId}` })}>
                    Use
                  </button>
                )}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
    </div>
  );
}
