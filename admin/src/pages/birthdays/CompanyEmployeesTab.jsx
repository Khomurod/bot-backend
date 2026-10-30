import React, { useCallback, useEffect, useMemo, useState } from "react";
import * as api from "../../api";

/**
 * Communications → Birthdays → Employees: every employee with the American
 * name, the Telegram account and the photo their birthday card needs. (It was
 * Users → Company Employees until October 2026; the card's data now sits on
 * the same page as the birthdays it is for.)
 *
 * "Suggest Telegram accounts" matches employees to the Telegram users the bot
 * has seen, by display name only; a suggestion is marked as such until a
 * person confirms it or types another. Names and birthdays are edited on the
 * Birthdays tab beside it. See docs/architecture/employee-birthday-cards.md.
 */

function titleCase(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/(^|[\s-])(\S)/g, (_, sep, ch) => sep + ch.toUpperCase());
}

const MATCH_BADGE = {
  confirmed: { cls: "badge-active", label: "Confirmed" },
  suggested: { cls: "badge-inactive", label: "Suggested — check" },
};

function draftOf(e) {
  return {
    americanName: e.american_name || "",
    telegramUsername: e.telegram_username || "",
    telegramUserId: e.telegram_user_id || "",
  };
}

function EmployeeRow({ employee, onSaved, onPreview, flash }) {
  const [draft, setDraft] = useState(() => draftOf(employee));
  const [busy, setBusy] = useState(false);
  // Reset to the stored values only when THEY change: reloading the list after
  // another row is saved must not throw away what was typed in this one.
  const savedKey = JSON.stringify(draftOf(employee));
  useEffect(() => { setDraft(JSON.parse(savedKey)); }, [savedKey]);

  const changed = JSON.stringify(draft) !== savedKey;
  const badge = MATCH_BADGE[employee.telegram_match];
  const name = titleCase(`${employee.first_name} ${employee.last_name}`);

  const run = async (fn, ok) => {
    setBusy(true);
    try {
      await fn();
      flash({ type: "success", text: ok });
      await onSaved();
    } catch (err) {
      flash({ type: "error", text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const set = (key) => (e) => setDraft((d) => ({ ...d, [key]: e.target.value }));

  return (
    <tr>
      <td style={{ fontWeight: 500 }}>{name}</td>
      <td>
        <input className="form-input" aria-label={`American name for ${name}`} value={draft.americanName} onChange={set("americanName")} placeholder="—" />
      </td>
      <td>
        <input className="form-input" aria-label={`Telegram username for ${name}`} value={draft.telegramUsername} onChange={set("telegramUsername")} placeholder="@username" />
        <input className="form-input" aria-label={`Telegram user ID for ${name}`} value={draft.telegramUserId} onChange={set("telegramUserId")} placeholder="user ID (optional)" style={{ marginTop: 4, fontFamily: "monospace", fontSize: 12 }} />
        {badge && <span className={`badge ${badge.cls}`} style={{ marginTop: 4, display: "inline-block" }}>{badge.label}</span>}
      </td>
      <td>
        {employee.has_photo ? <span className="badge badge-active">Photo ✓</span> : <span style={{ color: "var(--text-secondary)" }}>No photo</span>}
        <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
          <label className="btn btn-ghost btn-sm" style={{ cursor: "pointer" }}>
            {employee.has_photo ? "Replace" : "Upload"}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              aria-label={`Photo for ${name}`}
              style={{ display: "none" }}
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) run(() => api.uploadCompanyEmployeePhoto(employee.id, file), `Photo saved for ${name}.`);
              }}
            />
          </label>
          {employee.has_photo && (
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => {
              if (window.confirm(`Remove ${name}'s photo?`)) run(() => api.deleteCompanyEmployeePhoto(employee.id), "Photo removed.");
            }}>Remove</button>
          )}
        </div>
      </td>
      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
        <button className="btn btn-primary btn-sm" disabled={busy || !changed} onClick={() => run(() => api.updateCompanyEmployee(employee.id, draft), `Saved ${name}.`)}>Save</button>
        {employee.telegram_match === "suggested" && !changed && (
          <button className="btn btn-ghost btn-sm" style={{ marginLeft: 6 }} disabled={busy} onClick={() => run(() => api.confirmCompanyEmployeeTelegram(employee.id), `Telegram account confirmed for ${name}.`)}>Confirm</button>
        )}
        <button className="btn btn-ghost btn-sm" style={{ marginLeft: 6 }} onClick={() => onPreview(employee)}>Card</button>
      </td>
    </tr>
  );
}

export default function CompanyEmployeesTab() {
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState(null);
  const [search, setSearch] = useState("");
  const [suggesting, setSuggesting] = useState(false);
  const [preview, setPreview] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await api.getCompanyEmployees();
      setEmployees(Array.isArray(data?.employees) ? data.employees : []);
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => () => { if (preview?.url) URL.revokeObjectURL(preview.url); }, [preview]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return employees;
    return employees.filter((e) => [e.first_name, e.last_name, e.american_name, e.telegram_username]
      .some((v) => String(v || "").toLowerCase().includes(q)));
  }, [employees, search]);

  const noTelegram = employees.filter((e) => !e.telegram_username && !e.telegram_user_id).length;
  const toCheck = employees.filter((e) => e.telegram_match === "suggested").length;
  const noPhoto = employees.filter((e) => !e.has_photo).length;

  const suggest = async () => {
    setSuggesting(true);
    try {
      const out = await api.suggestCompanyEmployeeTelegram();
      if (Array.isArray(out?.employees)) setEmployees(out.employees);
      setMessage({ type: "success", text: `${out?.suggested ?? 0} Telegram account(s) suggested. Check the ones marked "Suggested".` });
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setSuggesting(false);
    }
  };

  const openPreview = async (employee) => {
    try {
      const url = await api.getCompanyEmployeeCardUrl(employee.id);
      setPreview({ url, name: titleCase(employee.first_name) });
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    }
  };

  return (
    <div>
      <p style={{ color: "var(--text-secondary)", marginTop: 0 }}>
        Everyone on the staff list. On their birthday the bot posts their card — photo, full first name and American
        name — to the employee group and tags their Telegram account. Saving a row confirms the account shown.
      </p>
      {message && <div className={`alert alert-${message.type === "error" ? "error" : "success"}`}>{message.text}</div>}

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16, flexWrap: "wrap" }}>
        <input type="text" placeholder="Search by name, American name or @username…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 340 }} />
        <button className="btn btn-secondary" onClick={suggest} disabled={suggesting}>
          {suggesting ? "Matching…" : "Suggest Telegram accounts"}
        </button>
        <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>
          {employees.length} employees · {noTelegram} without Telegram · {toCheck} to check · {noPhoto} without photo
        </span>
      </div>

      {loading ? (
        <div className="loading"><div className="spinner"></div> Loading…</div>
      ) : filtered.length === 0 ? (
        <div style={{ color: "var(--text-secondary)" }}>No employees match.</div>
      ) : (
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>American name</th>
                <th>Telegram</th>
                <th>Photo</th>
                <th style={{ textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((e) => (
                <EmployeeRow key={e.id} employee={e} onSaved={load} onPreview={openPreview} flash={setMessage} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {preview && (
        <div className="confirm-overlay" onClick={() => setPreview(null)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
            <h3>{preview.name}&apos;s birthday card</h3>
            <img src={preview.url} alt={`Birthday card for ${preview.name}`} style={{ width: "100%", borderRadius: 8 }} />
            <div className="confirm-actions">
              <button className="btn btn-ghost" onClick={() => setPreview(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
