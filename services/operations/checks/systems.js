/**
 * Cross-system checks — pure, no I/O.
 *
 * Each feature keeps its own idea of who a driver is and which truck they are
 * in; these compare them. None is auto-correctable: every disagreement here is
 * either a decision (which chat gets the alerts) or a state change with
 * consequences, and the registry's rule is that those belong to a person.
 *
 *   Samsara — the same vehicle linked to two active chats, or a chat's vehicle
 *   disagreeing with the truck recorded for its driver.
 *   Raise / mileage — progress rows the person layer could not place.
 */

const { createHash } = require('node:crypto');

/** A stable id for a SET of names: the same cohort updates one row, a different one is a new finding. */
function cohortKey(names) {
  return createHash('sha1').update([...names].sort().join('\n')).digest('hex').slice(0, 12);
}

function activeDriverGroups(groups) {
  return groups.filter((g) => g.group_type === 'driver' && g.active === true);
}

function label(group) {
  return group?.group_name || (group ? `Group ${group.id}` : 'a group that no longer exists');
}

/** One Samsara vehicle on two active chats: a safety alert would route to both, or to the wrong one. */
function checkSamsaraVehicleOnTwoGroups({ groups }) {
  const byVehicle = new Map();
  for (const g of activeDriverGroups(groups)) {
    const v = g.samsara_vehicle_id ? String(g.samsara_vehicle_id).trim() : '';
    if (!v) continue;
    if (!byVehicle.has(v)) byVehicle.set(v, []);
    byVehicle.get(v).push(g);
  }
  const findings = [];
  for (const [vehicleId, held] of byVehicle) {
    if (held.length < 2) continue;
    findings.push({
      checkKey: 'samsara.vehicle_on_two_active_groups',
      subjectType: 'samsara_vehicle',
      subjectId: vehicleId,
      title: `Samsara vehicle ${vehicleId} is linked to ${held.length} active driver groups`,
      severity: 'warning',
      tier: 'warning',
      evidence: { vehicleId, groups: held.map((g) => ({ groupId: g.id, groupName: g.group_name })) },
    });
  }
  return findings;
}

/** The chat says one vehicle; the driver's recorded truck says another. */
function checkSamsaraLinkDisagrees({ groups, personGroups, units }) {
  const open = new Map((personGroups || []).map((a) => [a.group_id, a.person_id]));
  const unitByPerson = new Map((units || []).map((u) => [u.person_id, u]));
  const findings = [];
  for (const g of activeDriverGroups(groups)) {
    const groupVehicle = g.samsara_vehicle_id ? String(g.samsara_vehicle_id).trim() : '';
    const unit = unitByPerson.get(open.get(g.id));
    const unitVehicle = unit?.samsara_vehicle_id ? String(unit.samsara_vehicle_id).trim() : '';
    if (!groupVehicle || !unitVehicle || groupVehicle === unitVehicle) continue;
    findings.push({
      checkKey: 'samsara.vehicle_link_disagrees',
      subjectType: 'group',
      subjectId: g.id,
      title: `${label(g)} is linked to Samsara vehicle ${groupVehicle}, but the driver's truck ${unit.unit_number} is ${unitVehicle}`,
      severity: 'warning',
      tier: 'warning',
      evidence: {
        groupId: g.id, groupVehicleId: groupVehicle,
        personId: unit.person_id, unitNumber: unit.unit_number, unitVehicleId: unitVehicle,
      },
    });
  }
  return findings;
}

/** Mileage progress rows the person layer could not place — one finding, not one per row. */
function checkMileageWithoutPerson({ mileageProgress }) {
  const unplaced = (mileageProgress || []).filter((m) => m.person_id == null);
  if (!unplaced.length) return [];
  // Keyed by the cohort, not a constant: a dismissal keeps its status on the
  // same subject, so a constant key would let today's dismissal hide the
  // drivers who become unmatched next month.
  return [{
    checkKey: 'raise.progress_without_person',
    subjectType: 'mileage_progress',
    subjectId: cohortKey(unplaced.map((m) => m.driver_normalized_name)),
    title: `${unplaced.length} mileage-bonus driver${unplaced.length === 1 ? '' : 's'} could not be matched to a permanent identity`,
    severity: 'info',
    tier: 'warning',
    evidence: {
      count: unplaced.length,
      names: unplaced.slice(0, 20).map((m) => m.driver_normalized_name),
      reason: 'No canonical person normalises to this name, or more than one does.',
    },
  }];
}

const CHECKS = [
  checkSamsaraVehicleOnTwoGroups,
  checkSamsaraLinkDisagrees,
  checkMileageWithoutPerson,
  // Declared below; function declarations hoist, so the reference is live.
  checkNotificationDestination,
];


/**
 * Wenze has things to say and nowhere to say them.
 *
 * `resolveDestination` returns `via: 'none'` when no default chat id is set,
 * and `notify()` then records nothing and queues nothing — deliberately, so a
 * destination configured months later cannot deliver a backlog of stale alerts
 * into a live staff chat.
 *
 * The consequence is that EVERY feature that speaks would run, work, and say
 * nothing, until somebody opened a settings screen they had no particular
 * reason to know existed. That is the exact shape of the failure this whole
 * project started from: the outbox retried, backed off, gave up, recorded the
 * error, and told nobody, and 101 staff alerts were lost over several months.
 *
 * So the absence is made LOUD rather than repaired by guessing. A chat id
 * invented from another feature's settings would put safety escalations and
 * retention signals into a room chosen for a different audience, which is a
 * decision for a person. This check puts it on the one screen an operator already reads.
 */
function checkNotificationDestination({ notificationSettings }) {
  // Absent settings means the table is not there yet — a deploy in progress,
  // not a misconfiguration. Silence is correct until there is a row to read.
  if (!notificationSettings) return [];
  if (notificationSettings.enabled === false) return [];

  const fallback = String(notificationSettings.defaultChatId || '').trim();
  if (fallback) return [];

  const overrides = Object.values(notificationSettings.categoryChatIds || {})
    .filter((v) => String(v || '').trim());

  return [{
    checkKey: 'ops.no_notification_destination',
    subjectType: 'settings',
    subjectId: 'operational_notifications',
    title: overrides.length
      ? `No default notification group — ${overrides.length} categories are configured and the rest are silent`
      : 'No notification group is configured — every automatic notice is being discarded',
    severity: overrides.length ? 'warning' : 'serious',
    tier: 'warning',
    confidence: 100,
    evidence: {
      defaultChatId: null,
      configuredCategories: Object.keys(notificationSettings.categoryChatIds || {})
        .filter((k) => String(notificationSettings.categoryChatIds[k] || '').trim()),
      whatIsLost: 'automatic corrections, safety escalations, retention signals, '
        + 'self-healing notices and learning suggestions',
      where: 'Settings → Notifications → AI & Operations notifications',
    },
  }];
}

const CHECK_KEYS = [
  'samsara.vehicle_on_two_active_groups',
  'samsara.vehicle_link_disagrees',
  'raise.progress_without_person',
  'ops.no_notification_destination',
];

function runSystemChecks(snapshot) {
  return CHECKS.flatMap((check) => check(snapshot));
}

module.exports = {
  CHECK_KEYS,
  runSystemChecks,
  checkSamsaraVehicleOnTwoGroups,
  checkSamsaraLinkDisagrees,
  checkMileageWithoutPerson,
  checkNotificationDestination,
};
