import React, { useState } from "react";
import api from "../../api/trailerDepartment";
import { Alert, Card, Field, PageHeader, useLoad } from "./TrailerUi";

/**
 * Settings, grouped by what a person is trying to configure. Advanced,
 * rarely-touched fields live in a collapsed group at the bottom.
 */
const GROUPS = [
  {
    key: "general",
    title: "General",
    intro: "Time zone used for billing days and reminder schedules.",
    fields: [["reminder_timezone", "Time zone", "text"]],
  },
  {
    key: "notifications",
    title: "Payment and reminder messages",
    intro: "Where Telegram confirmations and overdue reminders are sent, and who is responsible.",
    fields: [
      ["payment_confirmation_group_id", "Payment confirmation group", "text"],
      ["overdue_reminder_group_id", "Overdue reminder group", "text"],
      ["responsible_telegram_username", "Responsible person (username)", "text"],
      ["escalation_telegram_username", "Escalation contact (username)", "text"],
      ["reminder_hour", "Send reminders at (hour, 0–23)", "number"],
      ["reminder_repeat_days", "Repeat reminders every (days)", "number"],
      ["reminder_escalation_days", "Escalate after (days overdue)", "number"],
    ],
  },
  {
    key: "billing",
    title: "Billing",
    intro: "The grace period is applied once, at reminder time — never baked into due dates.",
    fields: [["payment_grace_period_days", "Grace period (days)", "number"]],
  },
  {
    key: "advanced",
    title: "Advanced",
    intro: "Numeric Telegram IDs — only needed when a username cannot be resolved.",
    collapsed: true,
    fields: [
      ["responsible_telegram_user_id", "Responsible person (numeric ID)", "text"],
      ["escalation_telegram_user_id", "Escalation contact (numeric ID)", "text"],
    ],
  },
];

export default function TrailerSettingsPage() {
  const { data, loading, error, reload } = useLoad(() => api.settings(), []);
  const [edit, setEdit] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(() => new Set(GROUPS.filter((g) => !g.collapsed).map((g) => g.key)));

  const value = edit || data?.settings || {};
  const set = (key, next) => setEdit({ ...value, [key]: next });
  const toggle = (key) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const save = async () => {
    setBusy(true);
    try {
      await api.updateSettings(value);
      setMsg({ text: "Settings saved." });
      setEdit(null);
      reload();
    } catch (e) {
      setMsg({ type: "error", text: e.message });
    } finally { setBusy(false); }
  };

  const test = async (target) => {
    setBusy(true);
    try {
      await api.testTelegram(target);
      setMsg({ text: "Test message sent — check the Telegram group." });
      reload();
    } catch (e) {
      setMsg({ type: "error", text: e.message });
    } finally { setBusy(false); }
  };

  if (loading) return <div className="loading"><div className="spinner" />Loading…</div>;

  return (
    <div>
      <PageHeader
        title="Settings"
        subtitle="How the Trailer Department bills, reminds and stores files."
      />
      <Alert message={msg} />
      {error && <div className="alert alert-danger">{error}</div>}

      <Card>
        <h3>Uploads and storage</h3>
        <p className="trailer-help">
          Photos and documents are stored {data?.storage_backend === "supabase"
            ? "in private cloud storage" : "safely inside the database"} — uploads
          always work, no setup required.
        </p>
      </Card>

      {GROUPS.map((group) => (
        <Card key={group.key}>
          <button type="button" className="trailer-group-toggle" aria-expanded={open.has(group.key)}
            onClick={() => toggle(group.key)}>
            <h3>{group.title}</h3>
            <span aria-hidden="true">{open.has(group.key) ? "▾" : "▸"}</span>
          </button>
          {open.has(group.key) && (
            <>
              <p className="trailer-help">{group.intro}</p>
              <div className="trailer-form-grid">
                {group.fields.map(([key, label, type]) => (
                  <Field key={key} label={label}>
                    <input
                      type={type}
                      value={value[key] ?? ""}
                      onChange={(e) => set(key, type === "number" ? Number(e.target.value) : e.target.value)}
                    />
                  </Field>
                ))}
                {group.key === "notifications" && (
                  <>
                    <Field label="Weekend behavior">
                      <select value={value.reminder_weekend_behavior || "skip"}
                        onChange={(e) => set("reminder_weekend_behavior", e.target.value)}>
                        <option value="skip">Skip weekends</option>
                        <option value="send">Send on weekends too</option>
                      </select>
                    </Field>
                    <label className="trailer-check">
                      <input type="checkbox" checked={Boolean(value.reminders_enabled)}
                        onChange={(e) => set("reminders_enabled", e.target.checked)} />
                      Send overdue reminders automatically
                    </label>
                    <p className="trailer-help">
                      Reminders can be turned on only after both groups have received a successful test message.
                    </p>
                    <div className="trailer-actions">
                      <button type="button" className="btn btn-secondary" disabled={busy}
                        onClick={() => test("payment")}>Send a test to the payment group</button>
                      <button type="button" className="btn btn-secondary" disabled={busy}
                        onClick={() => test("overdue")}>Send a test to the overdue group</button>
                    </div>
                  </>
                )}
              </div>
            </>
          )}
        </Card>
      ))}

      <div className="trailer-actions">
        <button type="button" className="btn btn-primary" disabled={busy || !edit} onClick={save}>
          {busy ? "Saving…" : "Save settings"}
        </button>
        {edit && (
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setEdit(null)}>
            Discard changes
          </button>
        )}
      </div>
    </div>
  );
}
