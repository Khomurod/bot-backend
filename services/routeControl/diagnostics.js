/**
 * Safe structured logging + correlation ids for Route Control.
 *
 * Every field written here is ALLOWLISTED: never tokens, URLs, message bodies,
 * screenshot bytes, personal data or stack traces. The same stable codes appear
 * in the Admin panel, so Admin ↔ logs can be tied together by correlation id.
 */

/** A safe, non-secret correlation id so Admin ↔ logs can be tied together. */
function makeEditCorrelationId(assignmentId) {
  return `rc-edit-${assignmentId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** ISO timestamp for a Date / date-like value, defaulting to now. */
function nowIso(now) {
  const d = now instanceof Date ? now : (now ? new Date(now) : new Date());
  return d.toISOString();
}

/**
 * One structured, SAFE log line per media-edit attempt / final outcome. Only
 * allowlisted fields — never tokens, URLs, message content, screenshot bytes,
 * personal data, or stack traces. The same stable code appears in the Admin panel.
 */
function logEditAttempt({
  correlationId, assignmentId, operation, chatId, attempt, ok, durationMs, aborted, classification,
}) {
  const rec = {
    evt: 'route_edit_attempt',
    cid: correlationId,
    assignment: assignmentId,
    operation,
    attempt,
    ok: Boolean(ok),
    durationMs: durationMs ?? null,
    // True when OUR per-attempt timer cancelled this request — the timed-out
    // request was genuinely aborted (not left running) before any retry.
    aborted: Boolean(aborted),
    hasChatId: chatId != null,
    category: classification?.category || null,
    code: classification?.code || null,
    transportCode: classification?.transportCode || null,
    telegramErrorCode: classification?.telegramErrorCode ?? null,
    retryable: classification?.retryable ?? null,
  };
  console.log(`[ROUTE-CONTROL-EDIT] ${JSON.stringify(rec)}`);
}

/** The single final-outcome log line for an in-place edit. */
function logEditFinal(rec) {
  console.log(`[ROUTE-CONTROL-EDIT] ${JSON.stringify({ evt: 'route_edit_final', ...rec })}`);
}

module.exports = {
  makeEditCorrelationId,
  nowIso,
  logEditAttempt,
  logEditFinal,
};
