/**
 * Identity checks — pure, no I/O.
 *
 * Every one of these fires on production data today, and the expected counts are
 * recorded in the tests so a change in the rules shows up as a changed number
 * rather than as silence.
 *
 * The shared rule: a check reports a DISAGREEMENT between two things the database
 * already believes. It never guesses which side is right — that is the tier's job
 * (`auto` only where the answer is already recorded elsewhere), and for most of
 * these the honest tier is `warning`, because only a human knows which truck the
 * driver is actually sitting in.
 */
const { resolveDriverType, FLEET_TYPES } = require('../../../lib/drivers/fleetType');
const { extractUnitFromGroupName } = require('../../../lib/drivers/driverGroupTitle');

const SILENT_DAYS = 60;

/** Chats that are administrative, not drivers, however they are typed. */
const NON_DRIVER_TITLE = /\b(admin|feedback|leads|test|hr\s+personnel|automatic\s+updating)\b/i;

/**
 * A chat whose title reads as an office or utility room and carries no unit
 * number. A real driver group always names its truck.
 */
function looksAdministrative(name) {
  const title = name || '';
  return NON_DRIVER_TITLE.test(title) && !extractUnitFromGroupName(title);
}

/** Why a status disagreement needs asking, by who set the chat's status. */
const STATUS_REASON = Object.freeze({
  bot: 'the bot saw the chat change, but the profile was never updated to match',
  ai: 'the chat\'s status came from an AI reading, and nothing the bot saw confirms it',
  manual: 'someone set the chat\'s status by hand, and the profile was never updated to match',
  unknown: 'nothing I can see settles which of the two is right',
});

function daysBetween(now, value) {
  if (!value) return null;
  const then = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(then.getTime())) return null;
  return Math.floor((now.getTime() - then.getTime()) / 86400000);
}

function profilesByGroup(profiles) {
  return new Map(profiles.map((p) => [p.group_id, p]));
}

function activeDriverGroups(groups) {
  return groups.filter((g) => g.group_type === 'driver' && g.active === true);
}

/**
 * `groups.active` and `driver_profiles.status` say different things.
 *
 * 42 of these in production — a fifth of the fleet. Nothing syncs group→profile:
 * `syncGroupFromDriverProfile` only ever writes profile→group, and only when the
 * caller passed `status`.
 *
 * WHO decided the group's state picks the CHECK, not just the tier, because the
 * two are answered by different actions:
 *
 *   `identity.status_disagreement`   `status_source = 'bot'` — Telegram itself
 *                                    told us the bot was added or kicked. Hard
 *                                    evidence; the profile is simply stale, so
 *                                    `identity.sync_profile_status` copies it.
 *   `identity.status_needs_decision` an 'ai' or 'manual' source — a judgement.
 *                                    Nothing observed it, so the sync refuses,
 *                                    and a person chooses Working or Not
 *                                    working through `identity.set_driver_status`.
 *
 * One check key with both shapes is what made the owner's "Yes" in the control
 * channel come back as "Somebody fixed it first": the approval-tier finding was
 * wired to an action that can only ever carry a bot-observed state.
 *
 * A chat whose title reads as an admin room is NOT asked about here. "Is Wenze
 * Facebook Leads working?" is a question nobody can answer; the right question
 * is whether it is a driver group at all, and
 * `identity.non_driver_typed_as_driver` asks exactly that.
 */
function checkStatusDisagreement({ groups, profiles }) {
  const byGroup = profilesByGroup(profiles);
  const findings = [];
  for (const group of groups) {
    if (group.group_type !== 'driver') continue;
    if (looksAdministrative(group.group_name)) continue;
    const profile = byGroup.get(group.id);
    if (!profile || !profile.status) continue;

    const groupSaysActive = group.active === true;
    const profileSaysActive = profile.status === 'active';
    if (groupSaysActive === profileSaysActive) continue;

    const botObserved = group.status_source === 'bot';
    findings.push({
      checkKey: botObserved ? 'identity.status_disagreement' : 'identity.status_needs_decision',
      subjectType: 'group',
      subjectId: group.id,
      title: `${group.group_name || `Group ${group.id}`}: group says ${groupSaysActive ? 'active' : 'inactive'}, profile says ${profile.status}`,
      severity: 'warning',
      tier: botObserved ? 'auto' : 'approval',
      confidence: botObserved ? 95 : 70,
      evidence: {
        groupId: group.id,
        groupName: group.group_name,
        groupActive: group.active,
        profileStatus: profile.status,
        statusSource: group.status_source,
        statusUpdatedAt: group.status_updated_at,
        // For the question: who the driver is and which truck, so the owner is
        // asked about a person rather than a chat title.
        driverName: [profile.first_name, profile.last_name].filter(Boolean).join(' ') || null,
        unitNumber: profile.unit_number || extractUnitFromGroupName(group.group_name || '') || null,
        reason: STATUS_REASON[group.status_source] || STATUS_REASON.unknown,
      },
      proposedChange: {
        table: 'driver_profiles',
        groupId: group.id,
        field: 'status',
        from: profile.status,
        to: groupSaysActive ? 'active' : 'inactive',
      },
    });
  }
  return findings;
}

/**
 * One unit number, several active drivers.
 *
 * Ten in production, including unit '001' on four active groups. This is the
 * condition migration 0015's partial unique index makes unrepresentable in the
 * person layer — so the backfill leaves the unit unclaimed, and this check is
 * what tells a human it needs deciding.
 *
 * Never auto-correctable: only a person knows which driver is really in it.
 */
function checkDuplicateUnits({ groups, profiles }) {
  const byGroup = profilesByGroup(profiles);
  const byUnit = new Map();

  for (const group of activeDriverGroups(groups)) {
    const profile = byGroup.get(group.id);
    // The profile column first, the title second — the same precedence the rest
    // of the app uses. Stored exactly as written: '001' and '01' are different.
    const unit = (profile?.unit_number || extractUnitFromGroupName(group.group_name) || '').trim();
    if (!unit) continue;
    const fleet = resolveDriverType({
      column: profile?.driver_type, title: group.group_name,
    }).fleetType;
    if (!byUnit.has(unit)) byUnit.set(unit, []);
    byUnit.get(unit).push({ group, profile, fleet });
  }

  const findings = [];
  for (const [unit, claimants] of byUnit) {
    if (claimants.length < 2) continue;

    // THE SAME NUMBER IN DIFFERENT FLEETS IS NOT A DUPLICATE. Company 001,
    // Owner-Operator 001 and Lease 001 are three trucks, and reporting all
    // three teaches an operator to ignore this check. So the claimants are
    // grouped by fleet — but ONLY when every one of them is placeable. A single
    // `unknown` among them means we cannot tell which truck it is, and then the
    // bare number is the honest bucket: `unknown` never wins a match, and it
    // must not be used to explain a collision away either.
    const anyUnknown = claimants.some((c) => c.fleet === FLEET_TYPES.UNKNOWN);
    const buckets = new Map();
    for (const claimant of claimants) {
      const key = anyUnknown ? unit : `${claimant.fleet}:${unit}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(claimant);
    }

    for (const [key, holders] of buckets) {
      if (holders.length < 2) continue;
      const fleet = anyUnknown ? null : holders[0].fleet;
      findings.push({
        checkKey: 'identity.duplicate_unit',
        subjectType: 'unit',
        subjectId: key,
        title: fleet
          ? `Unit ${unit} is on ${holders.length} active ${fleet.replace('_', ' ')} driver groups`
          : `Unit ${unit} is on ${holders.length} active driver groups`,
        // Four claimants is a different problem from two: it usually means the
        // unit is a placeholder nobody maintained.
        severity: holders.length > 2 ? 'serious' : 'warning',
        tier: 'warning',
        evidence: {
          unitNumber: unit,
          fleetType: fleet,
          // Said plainly, because "why is this still reported" is the first
          // question an operator asks about a number they have already explained.
          fleetKnown: !anyUnknown,
          ...(anyUnknown ? {
            note: 'at least one of these groups has no readable fleet label, so '
              + 'Wenze cannot tell whether these are the same truck',
          } : {}),
          groups: holders.map((h) => ({
            groupId: h.group.id,
            groupName: h.group.group_name,
            fleetType: h.fleet,
            driver: [h.profile?.first_name, h.profile?.last_name].filter(Boolean).join(' ') || null,
          })),
        },
      });
    }
  }
  return findings;
}

/**
 * The profile's unit and the Telegram title's unit disagree.
 *
 * Five in production. It matters because the two halves of the app read
 * different ones: Samsara safety routing and the `/status` lookup parse the
 * TITLE, while `/location`, the map and the duplicate scan read the PROFILE
 * COLUMN. A driver in this state can have safety alerts and live GPS pointing at
 * two different trucks simultaneously.
 */
function checkUnitTitleMismatch({ groups, profiles }) {
  const byGroup = profilesByGroup(profiles);
  const findings = [];
  for (const group of activeDriverGroups(groups)) {
    const profile = byGroup.get(group.id);
    const profileUnit = (profile?.unit_number || '').trim();
    const titleUnit = (extractUnitFromGroupName(group.group_name) || '').trim();
    if (!profileUnit || !titleUnit || profileUnit === titleUnit) continue;

    findings.push({
      checkKey: 'identity.unit_title_mismatch',
      subjectType: 'group',
      subjectId: group.id,
      title: `${group.group_name || `Group ${group.id}`}: profile says unit ${profileUnit}, title says ${titleUnit}`,
      severity: 'warning',
      tier: 'approval',
      confidence: 60,
      evidence: {
        groupId: group.id,
        groupName: group.group_name,
        profileUnit,
        titleUnit,
        readsTitle: ['samsara safety routing', 'driver status lookup', 'broadcast targeting'],
        readsProfile: ['/location', 'live locations map', 'duplicate unit scan'],
      },
    });
  }
  return findings;
}

/**
 * The group is active but the bot is not in it.
 *
 * Three in production. Everything the app tries to send there fails, and the
 * group still counts as live everywhere that filters on `active = TRUE`.
 */
function checkBotNotInActiveGroup({ groups }) {
  return activeDriverGroups(groups)
    .filter((g) => g.bot_member_status === 'left' || g.bot_member_status === 'kicked')
    .map((g) => ({
      checkKey: 'identity.bot_not_member',
      subjectType: 'group',
      subjectId: g.id,
      title: `${g.group_name || `Group ${g.id}`}: active, but the bot is "${g.bot_member_status}"`,
      severity: 'serious',
      tier: 'warning',
      evidence: {
        groupId: g.id,
        groupName: g.group_name,
        botMemberStatus: g.bot_member_status,
        botAccessCheckedAt: g.bot_access_checked_at,
        consequence: 'Every message this app sends to this group fails.',
      },
    }));
}

/** An active driver group nobody has spoken in for two months. */
function checkSilentActiveGroups({ groups, now }) {
  const findings = [];
  for (const group of activeDriverGroups(groups)) {
    const silentFor = daysBetween(now, group.last_message_seen_at);
    if (silentFor == null || silentFor <= SILENT_DAYS) continue;
    findings.push({
      checkKey: 'identity.silent_active_group',
      subjectType: 'group',
      subjectId: group.id,
      title: `${group.group_name || `Group ${group.id}`}: active but silent for ${silentFor} days`,
      severity: 'info',
      tier: 'approval',
      confidence: 55,
      evidence: {
        groupId: group.id,
        groupName: group.group_name,
        lastMessageSeenAt: group.last_message_seen_at,
        silentDays: silentFor,
        // Deactivating stops BOL/POD document delivery for this driver — the
        // approval UI has to say so before anyone clicks it.
        sideEffect: 'Deactivating also stops BOL/POD document routing for this group.',
      },
    });
  }
  return findings;
}

/**
 * An administrative chat carrying `group_type = 'driver'`.
 *
 * Five in production — "Employee Feedback (Admin)", "Driver Feedback (Admin)",
 * "Wenze Facebook Leads", "Automatic updating (Test)" and "HR Personnel". Each
 * has an auto-seeded driver profile and is counted as a driver by every query
 * that filters on the type.
 *
 * Title-shaped evidence only, so it proposes nothing and stays a warning.
 */
function checkNonDriverChatsTypedAsDriver({ groups }) {
  // ACTIVE OR NOT. An inactive admin room typed as a driver still has a
  // driver profile, still disagrees with it, and is skipped by the status
  // question above precisely so that THIS question is the one asked.
  return groups
    .filter((g) => g.group_type === 'driver' && looksAdministrative(g.group_name))
    .map((g) => ({
      checkKey: 'identity.non_driver_typed_as_driver',
      subjectType: 'group',
      subjectId: g.id,
      title: `"${g.group_name}" is typed as a driver group but looks administrative`,
      severity: 'info',
      tier: 'approval',
      confidence: 65,
      evidence: {
        groupId: g.id,
        groupName: g.group_name,
        groupType: g.group_type,
        groupActive: g.active === true,
        reason: 'its name has no truck number and reads like an office or admin chat, so it may not be a driver at all',
      },
    }));
}

const CHECKS = [
  checkStatusDisagreement,
  checkDuplicateUnits,
  checkUnitTitleMismatch,
  checkBotNotInActiveGroup,
  checkSilentActiveGroups,
  checkNonDriverChatsTypedAsDriver,
];

const CHECK_KEYS = [
  'identity.status_disagreement',
  'identity.status_needs_decision',
  'identity.duplicate_unit',
  'identity.unit_title_mismatch',
  'identity.bot_not_member',
  'identity.silent_active_group',
  'identity.non_driver_typed_as_driver',
];

/** Run every identity check over one snapshot. */
function runIdentityChecks(snapshot) {
  return CHECKS.flatMap((check) => check(snapshot));
}

module.exports = {
  SILENT_DAYS,
  CHECK_KEYS,
  runIdentityChecks,
  checkStatusDisagreement,
  checkDuplicateUnits,
  checkUnitTitleMismatch,
  checkBotNotInActiveGroup,
  checkSilentActiveGroups,
  checkNonDriverChatsTypedAsDriver,
  looksAdministrative,
};
