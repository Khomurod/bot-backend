import React, { useState } from "react";

import * as api from "../../api";
import { friendlyTimezone } from "../../utils/formatTime";
import { DEFAULT_TIMEZONE, TIMEZONE_OPTIONS, formatSchedule } from "./companyBirthdayText";

function formFrom(settings) {
  return {
    timezone: settings?.timezone || DEFAULT_TIMEZONE,
    sendHour: settings?.sendHour ?? 0,
    sendMinute: settings?.sendMinute ?? 0,
  };
}

/**
 * When the birthday cards are posted, as one line. Change opens the
 * timezone, hour and minute in place; Save writes them and closes the form.
 */
export default function PostingTimeLine({ settings, onSaved, onError }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(() => formFrom(settings));
  const [saving, setSaving] = useState(false);

  const open = () => {
    setForm(formFrom(settings));
    setEditing(true);
  };

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const updated = await api.updateEmployeeBirthdaySettings(form);
      setEditing(false);
      onSaved(updated);
    } catch (err) {
      onError(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <p style={{ margin: "0 0 16px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <span>
          {settings
            ? <>Birthday cards are posted every day at <strong>{formatSchedule(settings)}</strong>.</>
            : "Loading the posting time…"}
        </span>
        {settings && <button type="button" className="btn btn-ghost btn-sm" onClick={open}>Change</button>}
      </p>
    );
  }

  return (
    <form
      onSubmit={save} aria-label="Posting time"
      style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end", margin: "0 0 16px" }}
    >
      <div className="form-group" style={{ marginBottom: 0, minWidth: 200 }}>
        <label htmlFor="bd-timezone">Timezone</label>
        <select
          id="bd-timezone" className="form-input" value={form.timezone}
          onChange={(e) => setForm((s) => ({ ...s, timezone: e.target.value }))}
        >
          {TIMEZONE_OPTIONS.map((tz) => (
            <option key={tz} value={tz}>{friendlyTimezone(tz)} ({tz})</option>
          ))}
        </select>
      </div>
      <div className="form-group" style={{ marginBottom: 0, width: 110 }}>
        <label htmlFor="bd-hour">Hour (0–23)</label>
        <input
          id="bd-hour" className="form-input" type="number" min={0} max={23} value={form.sendHour}
          onChange={(e) => setForm((s) => ({ ...s, sendHour: Number(e.target.value) }))}
        />
      </div>
      <div className="form-group" style={{ marginBottom: 0, width: 110 }}>
        <label htmlFor="bd-minute">Minute (0–59)</label>
        <input
          id="bd-minute" className="form-input" type="number" min={0} max={59} value={form.sendMinute}
          onChange={(e) => setForm((s) => ({ ...s, sendMinute: Number(e.target.value) }))}
        />
      </div>
      <button className="btn btn-primary" type="submit" disabled={saving}>
        {saving ? "Saving..." : "Save"}
      </button>
      <button className="btn btn-ghost" type="button" disabled={saving} onClick={() => setEditing(false)}>Cancel</button>
    </form>
  );
}
