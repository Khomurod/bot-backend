/**
 * Telling somebody what Wenze just fixed by itself.
 *
 * The correction engine has been applying changes in the background since Phase
 * 3, audited and revertible — and completely silently. "The software corrected
 * it" is only trustworthy if you find out it happened; an operator who first
 * learns of it by noticing a driver's state changed has been given a mystery
 * rather than a service.
 *
 * Two deliberate limits:
 *
 *   ONE NOTICE PER CORRECTION, not per finding and not per sweep. The
 *   correction id is the discriminator, so a re-derived finding cannot
 *   re-announce a change that was already announced.
 *
 *   A BATCH IS ONE MESSAGE. The engine can apply up to its per-check cap in a
 *   single pass; 25 separate messages about 25 closed cycles is noise nobody
 *   reads, and the one that mattered is buried in it. Above the threshold the
 *   notice summarises and points at Needs attention → History.
 *
 * This runs AFTER the transaction commits, on purpose. A notice enqueued inside
 * the correction would be correct — the Home Time manager notice does exactly
 * that — but here the caller is a batch, and holding a batch's worth of
 * Telegram work inside its transactions would lengthen every lock for the sake
 * of a message.
 */
const { describeCorrection } = require('../../lib/operations/correctionLabels');
const {
  extractUnitFromGroupName, extractDriverNameFromGroupTitle,
} = require('../../lib/drivers/driverGroupTitle');

/** Above this many corrections in one pass, send a summary instead of each one. */
const SUMMARY_THRESHOLD = 4;

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    notify: require('../notifications/send').notify,
    groups: require('../../database/groups'),
    people: require('../../database/driverPeople'),
  };
  /* eslint-enable global-require */
}

/**
 * A driver group as a dispatcher says it: "Unit 310 — JOHN DOE". Falls back to
 * the title itself when it carries neither, which is still a name.
 */
function groupLabel(groupName) {
  const unit = extractUnitFromGroupName(groupName);
  const name = extractDriverNameFromGroupTitle(groupName);
  if (unit && name) return `Unit ${unit} — ${name}`;
  if (unit) return `Unit ${unit}`;
  return String(groupName || '').trim() || null;
}

/**
 * WHO the correction was about, in words.
 *
 * It said "group 59835" — the database's own row id, which nobody in the chat
 * can act on without opening the admin and searching. A group is a driver, and
 * a person has a name, so both are looked up. Anything else keeps the old
 * shape, and a lookup that fails falls back to it: a notice that names a row
 * id is worse than one that names the driver, and far better than no notice.
 */
async function subjectLine(correction, deps) {
  const { subjectType, subjectId } = correction;
  if (!subjectType || !subjectId) return '';
  const fallback = `${subjectType} ${subjectId}`;
  try {
    if (subjectType === 'group' && deps.groups?.getGroupByIdAnyType) {
      const group = await deps.groups.getGroupByIdAnyType(subjectId);
      return groupLabel(group?.group_name) || fallback;
    }
    if (subjectType === 'person' && deps.people?.getPersonById) {
      const person = await deps.people.getPersonById(subjectId);
      return person?.displayName || fallback;
    }
  } catch (_) {
    return fallback;
  }
  return fallback;
}

/**
 * Announce what one auto-correction pass did.
 *
 * @param {object[]} applied  `{correctionId, actionKey, subjectType, subjectId}`
 * @param {object} [deps]
 * @returns {Promise<{sent:number, skipped:number}>} — never throws. Telling
 *   somebody is a different job from fixing it, and the fix already committed.
 */
async function announceCorrections(applied = [], deps = defaultDeps()) {
  const rows = (applied || []).filter((r) => r && r.correctionId && r.actionKey);
  if (!rows.length) return { sent: 0, skipped: 0 };

  try {
    if (rows.length > SUMMARY_THRESHOLD) {
      const byAction = new Map();
      for (const r of rows) byAction.set(r.actionKey, (byAction.get(r.actionKey) || 0) + 1);
      const lines = [...byAction.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([key, n]) => `${n} × ${describeCorrection(key).did.toLowerCase()}`);
      const out = await deps.notify({
        category: 'automatic_corrections',
        title: `Wenze corrected ${rows.length} things`,
        lines,
        action: 'Open Needs attention → History to see each one, or undo any of them',
        subjectType: 'correction_batch',
        // The highest id in the batch: a stable, monotonic name for THIS pass,
        // so re-running the same pass says nothing and the next one does.
        subjectId: String(Math.max(...rows.map((r) => Number(r.correctionId) || 0))),
      });
      return { sent: out.delivered ? 1 : 0, skipped: rows.length - (out.delivered ? 1 : 0) };
    }

    let sent = 0;
    for (const r of rows) {
      const meta = describeCorrection(r.actionKey);
      // eslint-disable-next-line no-await-in-loop
      const who = await subjectLine(r, deps);
      // eslint-disable-next-line no-await-in-loop
      const out = await deps.notify({
        category: 'automatic_corrections',
        title: meta.did,
        lines: [who].filter(Boolean),
        reason: meta.why,
        action: meta.undoable ? 'Undo it in Needs attention → History' : null,
        subjectType: 'correction',
        subjectId: String(r.correctionId),
        evidence: { actionKey: r.actionKey, findingId: r.findingId ?? null },
      });
      if (out.delivered) sent += 1;
    }
    return { sent, skipped: rows.length - sent };
  } catch (err) {
    console.warn('[CORRECTIONS] could not announce:', err.message);
    return { sent: 0, skipped: rows.length };
  }
}

module.exports = { SUMMARY_THRESHOLD, announceCorrections, groupLabel };
