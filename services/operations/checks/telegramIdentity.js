/**
 * Which Telegram account belongs to which driver — pure, no I/O.
 *
 * ALL THE JUDGEMENT IS IN `lib/identity/telegramResolution.js`. This turns one
 * decision into one finding and nothing more, so the rule that can put one
 * person's account on another person's record stays readable as plain values.
 *
 * NOTHING IN THE MESSAGE PATH DECIDES THIS. The bot records who it has seen in
 * a chat and moves on; the sweep, fifteen minutes later, looks at the whole
 * room at once. A decision made per message would see one person at a time and
 * conclude "the only candidate" about whoever texted first.
 *
 *   identity.telegram_link              tier `auto`. One candidate, name agrees.
 *   identity.telegram_member_unnamed    tier `approval`. One candidate, the
 *                                       name does not look like the driver —
 *                                       common and often right, which is why a
 *                                       person confirms rather than a rule.
 *   identity.telegram_members_ambiguous tier `warning`. Several candidates, or
 *                                       a team chat. Nothing to propose.
 */
const { decideTelegramLink, CHECKS } = require('../../../lib/identity/telegramResolution');

const CHECK_KEYS = [
  'identity.telegram_link',
  CHECKS.UNNAMED,
  CHECKS.AMBIGUOUS,
];

function activeDriverGroups(groups) {
  return (groups || []).filter((g) => g && g.group_type === 'driver' && g.active === true);
}

/** How many DRIVER chats each account is in — the unlabelled-staff signal. */
function driverGroupCounts(members, driverGroupIds) {
  const counts = new Map();
  for (const m of members || []) {
    if (!driverGroupIds.has(m.group_id)) continue;
    const id = String(m.telegram_user_id);
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
}

function membersByGroup(members) {
  const out = new Map();
  for (const m of members || []) {
    if (!out.has(m.group_id)) out.set(m.group_id, []);
    out.get(m.group_id).push(m);
  }
  return out;
}

function driverNameOf(profile) {
  if (!profile) return '';
  return [profile.first_name, profile.last_name].filter(Boolean).join(' ').trim()
    || profile.full_name || '';
}

function runTelegramIdentityChecks({
  groups, profiles, personGroups, groupMembers, botUsers, linkedTelegramUserIds, telegramIdentities,
}) {
  const active = activeDriverGroups(groups);
  if (!active.length || !Array.isArray(groupMembers)) return [];

  const driverGroupIds = new Set(active.map((g) => g.id));
  const counts = driverGroupCounts(groupMembers, driverGroupIds);
  const byGroup = membersByGroup(groupMembers);
  const profileOf = new Map((profiles || []).map((p) => [p.group_id, p]));
  const personOf = new Map(
    (personGroups || []).filter((a) => a.ended_at == null).map((a) => [a.group_id, a.person_id])
  );
  const sourceOf = new Map(
    (botUsers || []).map((u) => [String(u.telegram_user_id), u.source])
  );
  const taken = linkedTelegramUserIds instanceof Set
    ? linkedTelegramUserIds
    : new Set((linkedTelegramUserIds || []).map(String));
  const peopleWithAccount = new Set(
    (telegramIdentities || []).filter((t) => t.ended_at == null).map((t) => Number(t.person_id))
  );

  const findings = [];
  for (const group of active) {
    const personId = personOf.get(group.id);
    if (!personId) continue; // a chat with no person has nobody to attribute to
    const profile = profileOf.get(group.id);
    const driverName = driverNameOf(profile);

    const members = (byGroup.get(group.id) || []).map((m) => ({
      telegramUserId: m.telegram_user_id,
      firstName: m.first_name,
      lastName: m.last_name,
      username: m.username,
      isBot: m.is_bot === true,
      source: sourceOf.get(String(m.telegram_user_id)) || null,
      driverGroupCount: counts.get(String(m.telegram_user_id)) || 0,
      alreadyLinked: taken.has(String(m.telegram_user_id)),
    }));

    const decision = decideTelegramLink({
      driverName,
      members,
      // A chat with a second driver named on the profile is a team chat.
      isTeamChat: Boolean(profile?.secondary_first_name || profile?.secondary_last_name),
      alreadyLinked: peopleWithAccount.has(Number(personId)),
    });
    if (decision.action === 'none') continue;

    const base = {
      subjectType: 'group',
      subjectId: group.id,
      evidence: {
        groupId: group.id,
        groupName: group.group_name,
        personId,
        driverName,
        candidates: decision.candidates,
        reason: decision.reason,
      },
      proposedChange: null,
    };

    if (decision.action === 'link') {
      findings.push({
        ...base,
        checkKey: 'identity.telegram_link',
        title: `${driverName || group.group_name}: one person in the chat matches the driver`,
        severity: 'info',
        tier: 'auto',
        confidence: decision.confidence,
        // The ACCOUNT travels in the proposal, never in the title — a Telegram
        // id in a finding's headline would be published to a notice.
        proposedChange: {
          personId, groupId: group.id, telegramUserId: decision.telegramUserId,
        },
      });
      continue;
    }

    findings.push({
      ...base,
      checkKey: decision.checkKey,
      title: decision.checkKey === CHECKS.UNNAMED
        ? `${driverName || group.group_name}: the one person in the chat does not look like the driver`
        : `${driverName || group.group_name}: Wenze cannot tell which account is the driver`,
      severity: 'info',
      tier: decision.checkKey === CHECKS.UNNAMED ? 'approval' : 'warning',
      confidence: 100,
    });
  }
  return findings;
}

module.exports = { CHECK_KEYS, runTelegramIdentityChecks, driverGroupCounts, driverNameOf };
