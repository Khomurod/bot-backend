'use strict';

/**
 * "Did I understand you right?" — turning a change the owner typed in their
 * own words into a question whose Yes makes exactly that change.
 *
 * The owner's decision of 6 November 2026 (`lib/control/changeCatalogue.js`):
 * a model may PROPOSE a value, but nothing is written until the owner answers
 * Yes to the exact change, shown in words. The change is stored ON THAT
 * QUESTION'S YES (`offeredActions[0].change`), so the ordinary rule still holds
 * at the writer: a reply chooses an answer the question offered, and the value
 * comes from the question, never from the reply (`services/control/actions.js`).
 *
 *   Yes    the change is applied through the correction registry, by the owner.
 *   No     nothing changes, and the original question stays open — "no" here
 *          means "you misread me", not "close it".
 *   later  the original finding is put aside, as with any question.
 *   anything else is read again against the ORIGINAL question, so "no, it is
 *          01" proposes the corrected change — at most `MAX_CHANGE_ROUNDS` times
 *          in one conversation, then Wenze stops proposing and says so.
 *
 * Only the chats the question was about can be changed: its subject chat, a
 * chat its evidence names, and the chats the daily board check found the driver
 * on (`wenzeElsewhere`). At most four, by title — the model never sees an id.
 */
const { describeChange, TARGET_LETTERS } = require('../../lib/control/changeCatalogue');
const { extractUnitFromGroupName } = require('../../lib/drivers/driverGroupTitle');
const { replyHintFor } = require('../../lib/control/askable');

const MAX_CHANGE_ROUNDS = 2;

/** The chat ids a finding is about, most direct first. */
function candidateGroupIds(finding) {
  const e = finding?.evidence || {};
  const ids = [];
  if (finding?.subjectType === 'group') ids.push(finding.subjectId);
  ids.push(e.groupId);
  for (const w of Array.isArray(e.wenzeElsewhere) ? e.wenzeElsewhere : []) ids.push(w?.groupId);
  for (const g of Array.isArray(e.groups) ? e.groups : []) ids.push(g?.groupId);
  const seen = new Set();
  return ids.map(Number).filter((id) => Number.isInteger(id) && id !== 0 && !seen.has(id) && seen.add(id))
    .slice(0, TARGET_LETTERS.length);
}

/** Each candidate chat with the profile values a change could touch — active driver chats only. */
async function changeTargets(finding, db) {
  const ids = candidateGroupIds(finding);
  if (!ids.length) return [];
  const res = await db.query(
    `SELECT g.id, g.group_name, dp.unit_number, dp.driver_type, dp.truck_fleet, dp.truck_owner, dp.status
       FROM groups g JOIN driver_profiles dp ON dp.group_id = g.id
      WHERE g.id = ANY($1::bigint[]) AND g.active = TRUE AND g.group_type = 'driver'`,
    [ids]
  );
  const byId = new Map(res.rows.map((r) => [Number(r.id), r]));
  return ids.filter((id) => byId.has(id)).map((id, i) => {
    const r = byId.get(id);
    return {
      letter: TARGET_LETTERS[i],
      groupId: id,
      groupName: r.group_name,
      current: {
        unitNumber: r.unit_number || null,
        driverType: r.driver_type || null,
        truckFleet: r.truck_fleet || null,
        truckOwner: r.truck_owner || null,
        status: r.status || null,
      },
    };
  });
}

/** What a person still has to do by hand after this change — today, only the chat title. */
function afterwards(change) {
  if (change.operation !== 'set_unit') return [];
  const titled = extractUnitFromGroupName(change.groupName || '');
  return titled && String(titled).trim().toUpperCase() !== change.values.unitNumber
    ? [`The chat title still says ${titled} — rename the chat in Telegram too, or I will ask about the mismatch.`]
    : [];
}

/**
 * Read a change out of the reply and, when there is one, ask the owner to
 * confirm it. Returns null when there is nothing to propose — the caller then
 * carries on exactly as before this existed.
 */
async function proposeChange({
  reply, notice, finding, text, prompt,
}, deps) {
  const round = Number(notice.question?.pending?.changeRound || 0);
  if (round >= MAX_CHANGE_ROUNDS || typeof deps.readChangeWithAi !== 'function') return null;
  const targets = await deps.changeTargets(finding).catch(() => []);
  if (!targets.length) return null;
  const { change } = await deps.readChangeWithAi(text, { question: prompt, targets });
  if (!change) return null;

  const said = describeChange(change);
  const offered = [
    { key: 'approve', label: 'yes', change },
    // NO MEANS "YOU MISREAD ME", not "close the finding": the original question
    // stays open (`actions.js` reads `rejectsChange`).
    { key: 'dismiss', label: 'no', rejectsChange: true },
    { key: 'snooze', label: 'later' },
  ];
  const ask = `Did I understand you right? ${said}`;
  const lines = [...afterwards(change), 'Yes → I make exactly this change; you can undo it in Operations → History.'];
  const root = notice.parentNoticeId || notice.id;
  const sent = await Promise.resolve(deps.notify({
    category: 'needs_attention',
    title: ask,
    lines: [...lines, replyHintFor(offered)],
    subjectType: 'control_reply',
    subjectId: `${reply.chatId}:${reply.messageId}`,
    findingId: notice.findingId,
    severity: 'info',
    inReplyTo: { chatId: reply.chatId, messageId: reply.messageId },
    question: {
      findingId: notice.findingId,
      decisionId: notice.question?.decisionId ?? null,
      offeredActions: offered,
      parentNoticeId: root,
      pending: { kind: 'confirm_change', changeRound: round + 1 },
      // THE ORIGINAL QUESTION, so a reply to this one ("no, it is 01") is read
      // against what the owner was first asked.
      prompt: notice.question?.prompt || prompt || null,
    },
    parentNoticeId: root,
    clarifyRound: Number(notice.clarifyRound || 0),
  })).catch(() => null);
  if (!sent?.recorded) return null;
  return { change, message: ask };
}

module.exports = {
  MAX_CHANGE_ROUNDS, candidateGroupIds, changeTargets, proposeChange, afterwards,
};
