/**
 * Home Time across a truck change — pure, no I/O.
 *
 * The production case this was written against: RUSLAN ABDULLAEV, group 49,
 * on the road since 2026-08-31 with one request and three legs on record; his
 * truck changed, a new chat (541877) was created 13 minutes after the last
 * message on the old one, and it started from nothing — `state_since =
 * 2026-09-01`, zero history. About four weeks of accrual and the extra-week
 * bonus that went with it were lost by recreating a chat.
 *
 * With the person layer the two chats are one driver, so this can be SEEN:
 * the person's current chat is on the road since a moment the old chat was
 * ALREADY on the road, and the old chat went quiet before the new one began.
 * The proposal is to carry the old clock — an APPROVAL, never automatic: it
 * changes a future payout, and only a person can confirm the driver did not
 * in fact go home between the two chats.
 */

function toDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** How long after the new chat began its clock may start and still read as "the same leg". */
const SAME_LEG_SLACK_MS = 3 * 86400000;

/**
 * @param {object} snapshot  groups, groupsById, homeStatus (with last_status_at,
 *   road_bonus_weeks_notified), personGroupHistory (every association, open and
 *   closed), people
 */
function checkClockResetOnGroupChange({ groupsById, homeStatus, personGroupHistory, people }) {
  const statusByGroup = new Map((homeStatus || []).map((s) => [s.group_id, s]));
  const names = new Map((people || []).map((p) => [p.id, p.display_name]));
  const byPerson = new Map();
  for (const a of personGroupHistory || []) {
    if (!byPerson.has(a.person_id)) byPerson.set(a.person_id, []);
    byPerson.get(a.person_id).push(a);
  }

  const findings = [];
  for (const [personId, associations] of byPerson) {
    const current = associations.find((a) => !a.ended_at && groupsById.get(a.group_id)?.active === true);
    if (!current) continue;
    const now = statusByGroup.get(current.group_id);
    if (!now || now.state !== 'road') continue;
    const nowSince = toDate(now.state_since);
    const startedAt = toDate(current.started_at);
    if (!nowSince) continue;
    // The new chat's clock began when the chat did — a first observation, not
    // a real transition. A clock that started well after the chat appeared was
    // a genuine home→road and is left alone.
    if (startedAt && nowSince.getTime() - startedAt.getTime() > SAME_LEG_SLACK_MS) continue;

    // ONLY the chat immediately before this one. A → B → C, where A ended on
    // the road but B recorded a home stay, must not lend A's clock to C across
    // B's known home period; the snapshot lists associations oldest first, so
    // the immediately preceding chat is the newest ended one.
    const previousChats = associations
      .filter((a) => a !== current && a.ended_at)
      .sort((a, b) => (toDate(b.ended_at)?.getTime() || 0) - (toDate(a.ended_at)?.getTime() || 0))
      .slice(0, 1);
    for (const previous of previousChats) {
      const before = statusByGroup.get(previous.group_id);
      if (!before || before.state !== 'road') continue;
      const beforeSince = toDate(before.state_since);
      const lastSeen = toDate(before.last_status_at) || beforeSince;
      if (!beforeSince || beforeSince >= nowSince) continue;
      // The old chat fell silent before the new one began its clock. A message
      // on the old chat AFTER that would mean the two ran in parallel.
      if (lastSeen && lastSeen > nowSince) continue;
      const oldGroup = groupsById.get(previous.group_id);
      const newGroup = groupsById.get(current.group_id);
      const lostDays = Math.floor((nowSince.getTime() - beforeSince.getTime()) / 86400000);
      findings.push({
        checkKey: 'home_time.clock_reset_on_group_change',
        subjectType: 'group',
        subjectId: current.group_id,
        title: `${names.get(personId) || `Person ${personId}`}: the road clock restarted on the new chat — `
          + `${lostDays} day${lostDays === 1 ? '' : 's'} on the road were left on ${oldGroup?.group_name || `group ${previous.group_id}`}`,
        severity: 'warning',
        tier: 'approval',
        confidence: 80,
        evidence: {
          personId,
          displayName: names.get(personId) || null,
          fromGroupId: previous.group_id,
          fromGroupName: oldGroup?.group_name || null,
          fromStateSince: before.state_since,
          fromLastStatusAt: before.last_status_at || null,
          fromWeeksNotified: before.road_bonus_weeks_notified ?? 0,
          toGroupId: current.group_id,
          toGroupName: newGroup?.group_name || null,
          toStateSince: now.state_since,
          lostDays,
        },
        proposedChange: {
          table: 'driver_home_status',
          personId,
          groupId: current.group_id,
          field: 'state_since',
          from: now.state_since,
          to: before.state_since,
          fromGroupId: previous.group_id,
          roadBonusWeeksNotified: { from: now.road_bonus_weeks_notified ?? 0, to: Math.max(now.road_bonus_weeks_notified ?? 0, before.road_bonus_weeks_notified ?? 0) },
        },
      });
      break; // one proposal per person: the most recent previous chat
    }
  }
  return findings;
}

const CHECK_KEYS = ['home_time.clock_reset_on_group_change'];

function runHomeTimeContinuityChecks(snapshot) {
  return checkClockResetOnGroupChange(snapshot);
}

module.exports = { SAME_LEG_SLACK_MS, CHECK_KEYS, runHomeTimeContinuityChecks, checkClockResetOnGroupChange };
