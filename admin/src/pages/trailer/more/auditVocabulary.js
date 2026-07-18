/**
 * Plain-language rendering of trailer audit actions. Dependency-free ESM so
 * node:test can verify every known action reads as a human sentence fragment
 * ("<who> <did what>"). Unknown actions degrade to de-jargonized text.
 */

export const AUDIT_ACTION_LABELS = {
  "rental.create": "started a rental",
  "rental.update": "updated a rental",
  "rental.activate": "confirmed a trailer pickup",
  "rental.return": "returned a trailer",
  "rental.cancelled": "cancelled a rental",
  "rental.disputed": "flagged a rental for review",
  "rental.event_link": "linked a trailer update to a rental",
  "agreement.close": "completed a rental",
  "agreement.item.activate": "confirmed a trailer pickup",
  "agreement.item.return": "returned a trailer",
  "agreement.invoice.combined": "created one invoice for all trailers",
  "agreement.invoice.separate": "created a separate trailer invoice",
  "inspection.create": "started an inspection",
  "inspection.update": "updated an inspection",
  "inspection.complete": "completed an inspection",
  "invoice.finalize": "created an invoice",
  "invoice.adjust": "adjusted an invoice",
  "invoice.reminder.pause": "paused reminders for an invoice",
  "invoice.reminder.resume": "resumed reminders for an invoice",
  "invoice.reminder.snooze": "snoozed reminders for an invoice",
  "invoice.reminder.waive": "waived reminders for an invoice",
  "invoice.reminder.dispute": "marked an invoice as needing review",
  "invoice.reminder.contacted": "noted the company was contacted",
  "invoice.reminder.escalate": "escalated an overdue invoice",
  "payment.create": "recorded a payment",
  "payment.reverse": "reversed a payment",
  "payment.overpayment_credit": "saved an extra payment as company credit",
  "credit.apply": "applied company credit to an invoice",
  "trailer.create": "added a trailer",
  "trailer.update": "updated a trailer",
  "company.create": "added a company",
  "company.update": "updated a company",
  "company.archive": "archived a company",
};

export function auditSentence(row) {
  const who = row.username || "Someone";
  const what = AUDIT_ACTION_LABELS[row.action]
    || String(row.action || "did something").replaceAll(".", " ").replaceAll("_", " ");
  return `${who} ${what}`;
}
