/**
 * Cross-system checks — pure, no I/O.
 *
 * Each feature keeps its own idea of who a driver is and which truck they are
 * in; these compare them. None is auto-correctable: every disagreement here is
 * either a decision (which chat gets the alerts, which seat the driver keeps)
 * or a state change with consequences (expiring a fuel watch, cancelling a
 * route), and the registry's rule is that those belong to a person.
 *
 *   Samsara — the same vehicle linked to two active chats, or a chat's vehicle
 *   disagreeing with the truck recorded for its driver.
 *   Fuel monitor — a watch still running on a chat nobody is in.
 *   Dispatch teams — a team seat pointing at a chat the driver has left, when
 *   the person layer knows where they are now.
 *   Raise / mileage — progress rows the person layer could not place.
 *   Route Control — an active route on a chat nobody is in.
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

/** A fuel-stop watch still running for a chat that is inactive or gone. */
function checkFuelWatchOnInactiveGroup({ groupsById, fuelAlerts }) {
  return (fuelAlerts || [])
    .filter((a) => a.status === 'watching')
    .filter((a) => { const g = groupsById.get(a.group_id); return !g || g.active !== true; })
    .map((a) => {
      const g = groupsById.get(a.group_id);
      return {
        checkKey: 'fuel.watch_on_inactive_group',
        subjectType: 'fuel_stop_alert',
        subjectId: a.id,
        title: `A fuel-stop watch is still running for ${label(g)}, which is inactive`,
        severity: 'warning',
        tier: 'warning',
        evidence: { alertId: a.id, groupId: a.group_id, groupName: g?.group_name || null, createdAt: a.created_at },
      };
    });
}

/**
 * A dispatch-team seat on a chat the driver has left, when the person layer
 * knows the chat they are on now. The move is proposed, not made: which team a
 * driver sits on is a payroll-adjacent decision.
 */
function checkTeamDriverOnInactiveGroup({ groups, groupsById, personGroups, teamDrivers }) {
  const currentGroupOfPerson = new Map();
  for (const a of personGroups || []) {
    const g = groupsById.get(a.group_id);
    if (g && g.active === true && g.group_type === 'driver') currentGroupOfPerson.set(a.person_id, g);
  }
  const findings = [];
  for (const seat of teamDrivers || []) {
    if (seat.active === false || !seat.group_id) continue;
    const g = groupsById.get(seat.group_id);
    if (g && g.active === true) continue;
    const current = seat.person_id ? currentGroupOfPerson.get(seat.person_id) : null;
    if (!current) continue; // nowhere to move it to — the driver may simply have left
    findings.push({
      checkKey: 'dispatch.team_driver_on_inactive_group',
      subjectType: 'dispatch_team_driver',
      subjectId: seat.id,
      title: `${seat.driver_name || 'A driver'}'s team seat points at ${label(g)}; they are now on ${current.group_name}`,
      severity: 'warning',
      tier: 'approval',
      confidence: 85,
      evidence: {
        seatId: seat.id, teamId: seat.team_id, personId: seat.person_id,
        fromGroupId: seat.group_id, fromGroupName: g?.group_name || null,
        toGroupId: current.id, toGroupName: current.group_name,
      },
      proposedChange: { table: 'dispatch_team_drivers', id: seat.id, field: 'group_id', from: seat.group_id, to: current.id },
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

/** An active route on a chat that is inactive or gone. */
function checkRouteOnInactiveGroup({ groupsById, routeAssignments }) {
  return (routeAssignments || [])
    .filter((r) => r.status === 'active' && r.group_id != null)
    .filter((r) => { const g = groupsById.get(r.group_id); return !g || g.active !== true; })
    .map((r) => {
      const g = groupsById.get(r.group_id);
      return {
        checkKey: 'route_control.assignment_on_inactive_group',
        subjectType: 'route_assignment',
        subjectId: r.id,
        title: `Route #${r.id} is still active for ${label(g)}, which is inactive`,
        severity: 'warning',
        tier: 'warning',
        evidence: { assignmentId: r.id, groupId: r.group_id, groupName: g?.group_name || null, createdAt: r.created_at },
      };
    });
}

const CHECKS = [
  checkSamsaraVehicleOnTwoGroups,
  checkSamsaraLinkDisagrees,
  checkFuelWatchOnInactiveGroup,
  checkTeamDriverOnInactiveGroup,
  checkMileageWithoutPerson,
  checkRouteOnInactiveGroup,
];

const CHECK_KEYS = [
  'samsara.vehicle_on_two_active_groups',
  'samsara.vehicle_link_disagrees',
  'fuel.watch_on_inactive_group',
  'dispatch.team_driver_on_inactive_group',
  'raise.progress_without_person',
  'route_control.assignment_on_inactive_group',
];

function runSystemChecks(snapshot) {
  return CHECKS.flatMap((check) => check(snapshot));
}

module.exports = {
  CHECK_KEYS,
  runSystemChecks,
  checkSamsaraVehicleOnTwoGroups,
  checkSamsaraLinkDisagrees,
  checkFuelWatchOnInactiveGroup,
  checkTeamDriverOnInactiveGroup,
  checkMileageWithoutPerson,
  checkRouteOnInactiveGroup,
};
