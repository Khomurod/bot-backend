/**
 * Truthful payment confirmation message (§8).
 *
 * After recording a payment the UI must tell the employee what actually
 * happened — amount applied, invoice, remaining balance, any company credit —
 * and the REAL delivery state of the Telegram receipt. It must never claim the
 * confirmation "is on its way" when the notification has already failed. The
 * delivery line is derived from the notification job's status returned by the
 * backend, not assumed.
 */

const usd = (n) => `$${Number(n || 0).toFixed(2)}`;

/**
 * Human delivery-state sentence for a notification job (or null when there is
 * no job). Statuses: pending | processing | sent | failed | cancelled.
 */
export function deliveryStateLine(notification) {
  const status = notification?.status;
  switch (status) {
    case 'sent':
      return 'The receipt was sent to Telegram.';
    case 'failed':
      return 'The Telegram receipt could not be sent — retry it from the invoice.';
    case 'cancelled':
      return 'Telegram delivery of the receipt was cancelled.';
    case 'pending':
    case 'processing':
      return 'A receipt will be sent to Telegram shortly.';
    default:
      return null; // no notification was created (e.g. not configured)
  }
}

/**
 * Compose the full confirmation. `result` is the recordPayment response
 * ({ payment, invoice, credit, notification }).
 */
export function paymentConfirmationMessage(result = {}) {
  const { payment, invoice, credit, notification } = result;
  const parts = [];
  if (payment?.amount != null) parts.push(`Payment of ${usd(payment.amount)} recorded`);
  else parts.push('Payment recorded');
  if (invoice?.invoice_number) parts[0] += ` on invoice ${invoice.invoice_number}`;
  parts[0] += '.';

  const outstanding = invoice?.outstanding_balance ?? invoice?.outstanding_amount;
  if (outstanding != null) {
    parts.push(Number(outstanding) <= 0.0001
      ? 'The invoice is now paid in full.'
      : `Remaining balance: ${usd(outstanding)}.`);
  }
  if (credit?.original_amount) {
    parts.push(`${usd(credit.original_amount)} extra was saved as company credit.`);
  }
  const delivery = deliveryStateLine(notification);
  if (delivery) parts.push(delivery);
  return parts.join(' ');
}
