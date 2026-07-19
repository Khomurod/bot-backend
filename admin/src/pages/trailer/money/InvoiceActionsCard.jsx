import React, { useState } from "react";
import api from "../../../api/trailerDepartment";
import { useAuth } from "../../../context/AuthContext";
import { Card, Empty, useLoad } from "../TrailerUi";

const usd = (n) => `$${Number(n || 0).toFixed(2)}`;

const REMINDER_STATE_COPY = {
  active: "Reminders are active.",
  paused: "Reminders are stopped for this invoice.",
  snoozed: "Reminders are snoozed.",
  waived: "Reminders are waived.",
};

const DELIVERY_COPY = {
  sent: "The payment confirmation was sent to Telegram.",
  pending: "A payment confirmation will be sent to Telegram shortly.",
  processing: "A payment confirmation is being sent.",
  failed: "The Telegram confirmation could not be sent.",
  cancelled: "Telegram delivery was cancelled.",
};

/**
 * State-appropriate invoice actions (§4): truthful notification status with
 * retry, reminder controls (snooze / stop / resume), and applying available
 * company credit — each gated on the payment-record permission and only shown
 * when the state makes the action meaningful.
 */
export default function InvoiceActionsCard({ invoice, onChanged, onMessage }) {
  const { can } = useAuth();
  const canAct = can("trailer_payments.record");
  const [busy, setBusy] = useState(false);
  const credits = useLoad(
    () => (canAct && Number(invoice.outstanding_balance) > 0
      ? api.companyCredits(invoice.company_id)
      : Promise.resolve({ credits: [] })),
    [invoice.company_id, invoice.outstanding_balance],
  );
  const openCredits = (credits.data?.credits || []).filter((c) => Number(c.remaining_amount) > 0);

  const run = async (fn, successText) => {
    setBusy(true);
    try {
      await fn();
      onMessage({ type: "success", text: successText });
      await onChanged();
    } catch (e) {
      onMessage({ type: "error", text: e.message });
    } finally { setBusy(false); }
  };

  const remind = (action, successText, extra = {}) =>
    run(() => api.reminderAction(invoice.id, { action, ...extra }), successText);

  if (!canAct) return null;

  return (
    <Card>
      <h3>Actions</h3>
      <div className="trailer-summary trailer-summary-stack">
        <span role="status">
          {DELIVERY_COPY[invoice.notification_status] || "No Telegram confirmation has been queued yet."}
          {invoice.notification_status === "failed" && invoice.notification_error
            ? ` (${String(invoice.notification_error).slice(0, 80)})` : ""}
        </span>
        {invoice.notification_status === "failed" && invoice.notification_job_id && (
          <button type="button" className="btn btn-secondary" disabled={busy}
            onClick={() => run(() => api.retryNotification(invoice.notification_job_id),
              "The notification is queued to send again.")}>
            Retry failed notification
          </button>
        )}

        <span>{REMINDER_STATE_COPY[invoice.reminder_state] || ""}</span>
        <div className="trailer-actions">
          {["active", "snoozed"].includes(invoice.reminder_state) && (
            <>
              <button type="button" className="btn btn-secondary" disabled={busy}
                onClick={() => remind("snooze", "Reminders snoozed for 7 days.", {
                  snoozedUntil: new Date(Date.now() + 7 * 86400000).toISOString(),
                })}>
                Snooze reminders 7 days
              </button>
              <button type="button" className="btn btn-secondary" disabled={busy}
                onClick={() => remind("pause", "Reminders stopped for this invoice.")}>
                Stop reminders
              </button>
            </>
          )}
          {["paused", "snoozed", "waived"].includes(invoice.reminder_state) && (
            <button type="button" className="btn btn-secondary" disabled={busy}
              onClick={() => remind("resume", "Reminders resumed.")}>
              Resume reminders
            </button>
          )}
        </div>

        {Number(invoice.outstanding_balance) > 0 && (
          credits.loading ? <span role="status">Checking company credit…</span>
            : !openCredits.length ? <Empty>No company credit available to apply.</Empty>
              : openCredits.map((c) => {
                const applicable = Math.min(Number(c.remaining_amount), Number(invoice.outstanding_balance));
                return (
                  <div className="trailer-actions" key={c.id}>
                    <span>Credit {usd(c.remaining_amount)} available{c.reason ? ` (${c.reason})` : ""}</span>
                    <button type="button" className="btn btn-secondary" disabled={busy}
                      onClick={() => run(
                        () => api.applyCredit(c.id, { invoice_id: invoice.id, amount: applicable }),
                        `${usd(applicable)} of company credit applied to this invoice.`,
                      )}>
                      Apply {usd(applicable)}
                    </button>
                  </div>
                );
              })
        )}
      </div>
    </Card>
  );
}
