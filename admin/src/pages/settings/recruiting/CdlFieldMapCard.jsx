import React from "react";

import * as api from "../../../api";

/**
 * Settings → Safety Approvals → 6. CDL → Bitrix fields.
 *
 * The owner, 14 November 2026: when somebody tags the bot under a lead's post,
 * an AI model the owner chose (Settings → AI) reads the CDL photo, and each
 * item goes to the Bitrix field picked here — on the candidate's contact or on
 * the deal. An item left unmapped, or whose field already has a value, goes
 * into ONE comment on the deal instead: a filled field is never overwritten.
 *
 * The field lists are read from Bitrix only when "Read the fields from Bitrix"
 * is pressed (read only). The values themselves are never stored in Wenze and
 * never shown here — the latest reads below are counts and reasons.
 */
const RESULT = {
  written: "Written",
  name_differs: "Name differs from the post — nothing written",
  unsure: "Not sure — nothing written",
  unreadable: "Could not be read",
  no_photo: "No photo",
  off: "Switched off",
  no_provider: "No provider chosen",
  no_deal: "No deal to write to",
  not_hiring: "Deal not in a hiring pipeline",
  team: "Post about more than one driver",
  bitrix_refused: "Bitrix refused",
};

const valueOf = (m) => (m ? `${m.entity}:${m.fieldCode}` : "");

export default function CdlFieldMapCard() {
  const [data, setData] = React.useState(null);
  const [fields, setFields] = React.useState(null);
  const [choice, setChoice] = React.useState({});
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState(null);

  const load = React.useCallback(async () => {
    try {
      const next = await api.getHiringCdl();
      setData(next);
      setChoice(Object.fromEntries((next.mapping || []).map((m) => [m.item, valueOf(m)])));
    } catch (err) {
      setMessage({ type: "error", text: err?.message || "Could not load the CDL field mapping." });
    }
  }, []);
  React.useEffect(() => { load(); }, [load]);

  const readFields = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const out = await api.readHiringCdlBitrixFields();
      if (!out.ok) setMessage({ type: "error", text: `Bitrix could not be read: ${out.error || "no answer"}` });
      else setFields({ contact: out.contact || [], deal: out.deal || [] });
    } catch (err) {
      setMessage({ type: "error", text: err?.message || "Bitrix could not be read." });
    } finally {
      setBusy(false);
    }
  };

  const describe = (value) => {
    const [entity, code] = value.split(":");
    const live = fields?.[entity]?.find((f) => f.code === code);
    const stored = (data?.mapping || []).find((m) => m.entity === entity && m.fieldCode === code);
    return { entity, fieldCode: code, fieldLabel: live?.label || stored?.fieldLabel || null, fieldType: live?.type || stored?.fieldType || null };
  };

  const save = async () => {
    setBusy(true);
    try {
      const mapping = Object.entries(choice).filter(([, v]) => v).map(([item, v]) => ({ item, ...describe(v) }));
      await api.saveHiringCdlMapping(mapping);
      setMessage({ type: "success", text: "CDL field mapping saved." });
      await load();
    } catch (err) {
      setMessage({ type: "error", text: err?.message || "Could not save the mapping." });
    } finally {
      setBusy(false);
    }
  };

  if (!data) {
    return message ? <div className="card" style={{ marginTop: 16 }}><p className="error">{message.text}</p></div> : null;
  }
  const taken = new Set(Object.values(choice).filter(Boolean));
  const savedOption = (item) => (data.mapping || []).find((m) => m.item === item);

  const options = (item, entity) => {
    const list = fields?.[entity] || [];
    const saved = savedOption(item);
    const extra = saved && saved.entity === entity && !list.some((f) => f.code === saved.fieldCode)
      ? [{ code: saved.fieldCode, label: saved.fieldLabel || saved.fieldCode, saved: true }] : [];
    return [...extra, ...list].map((f) => {
      const value = `${entity}:${f.code}`;
      return (
        <option key={value} value={value} disabled={taken.has(value) && choice[item] !== value}>
          {f.label}{f.label !== f.code ? ` (${f.code})` : ""}{f.saved && fields ? " — not in Bitrix now" : ""}
        </option>
      );
    });
  };

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3 style={{ marginTop: 0 }}>6. CDL → Bitrix fields</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        When somebody tags the bot under a lead&apos;s post, the AI model chosen in Settings → AI reads the CDL photo.
        Each item goes to the Bitrix field picked here. A field that already has a value is <b>never overwritten</b>;
        unmapped items go into <b>one comment on the deal</b>. The values are never stored in Wenze or posted in
        Telegram — the driver&apos;s card only says how many were written.
      </p>
      {message && <div className={`alert alert-${message.type}`} style={{ marginBottom: 10 }}>{message.text}</div>}
      <button type="button" className="btn btn-ghost" onClick={readFields} disabled={busy}>
        {fields ? "Read the fields from Bitrix again" : "Read the fields from Bitrix"}
      </button>
      {!fields && <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>Needed to change the mapping.</span>}

      <table className="data-table" style={{ marginTop: 12 }}>
        <thead><tr><th>On the CDL</th><th>Goes to</th></tr></thead>
        <tbody>
          {data.items.map((item) => (
            <tr key={item.key}>
              <td><label htmlFor={`cdl-${item.key}`}>{item.label}</label></td>
              <td>
                <select id={`cdl-${item.key}`} className="form-input" value={choice[item.key] || ""}
                  disabled={busy || (!fields && !savedOption(item.key))}
                  onChange={(e) => setChoice((c) => ({ ...c, [item.key]: e.target.value }))}>
                  <option value="">— not mapped: into the comment —</option>
                  <optgroup label="Contact">{options(item.key, "contact")}</optgroup>
                  <optgroup label="Deal">{options(item.key, "deal")}</optgroup>
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className="btn btn-primary" style={{ marginTop: 10 }} onClick={save} disabled={busy}>
        Save mapping
      </button>

      {data.recent?.length > 0 && (
        <table className="data-table" style={{ marginTop: 16 }}>
          <thead><tr><th>When</th><th>CDL read</th><th>Items</th></tr></thead>
          <tbody>
            {data.recent.map((r) => (
              <tr key={r.id}>
                <td>{new Date(r.createdAt).toLocaleString()}</td>
                <td>{RESULT[r.status] || r.status}{r.providerKey ? ` — ${r.providerKey}` : ""}{r.nameFromCdl ? " (name read from the CDL)" : ""}</td>
                <td>{r.status === "written" || r.status === "bitrix_refused"
                  ? `${r.itemsWritten} written, ${r.itemsInComment} in a comment${r.dealId ? ` — deal #${r.dealId}` : ""}` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
