'use strict';

/**
 * What a group's TITLE says a driver profile should be, and when the profile
 * should follow it. Pure.
 *
 * The fleet names its driver chats by a convention: "( COMPANY )" or "(COMPANY
 * DRIVER)" is a company driver, "LEASE" a lease driver, nothing an owner
 * operator; and an operator appends "INACTIVE" when a driver leaves. The
 * profile used to read the title ONCE, when the chat was first seen — so a
 * chat renamed later kept its old type and status: 15 company drivers typed
 * as owner operators and 20 "INACTIVE" chats shown as active (October 2026).
 *
 * TWO MOMENTS, TWO RULES:
 *
 *   A RENAME (`previousName` given) is a person's act, newer than anything
 *   stored, so it is followed even over a manual setting — but only for what
 *   the rename CHANGED: "INACTIVE" added makes the driver inactive, removed
 *   makes them active again; a fleet word added or removed changes the type.
 *
 *   A RECONCILE (no `previousName`: the one pass at startup) only brings
 *   profiles up to what the title says now, never over a manual setting, and
 *   never reactivates anybody — a chat without "INACTIVE" may be inactive for
 *   a reason the title does not carry.
 */

const { titleFleetClaim, nameMarkedInactive } = require('./driverProfileParse');

/**
 * @param {object} profile   { driver_type, driver_type_source, status }
 * @param {object} args
 * @param {string} args.title            the title now
 * @param {string} [args.previousName]   the title before a rename
 * @param {string|null} [args.statusSource]  groups.status_source ('manual' locks a reconcile)
 * @returns {{patch: object, changed: string[]}}
 */
function profilePatchFromTitle(profile, { title, previousName, statusSource = null }) {
  const patch = {};
  const changed = [];
  const renamed = typeof previousName === 'string' && previousName !== title;

  const fleetNow = titleFleetClaim(title);
  const wantType = fleetNow || 'owner';
  const typeLocked = profile.driver_type_source === 'manual';
  const typeEdge = renamed && titleFleetClaim(previousName) !== fleetNow;
  // A reconcile acts only on an EXPLICIT claim: "nothing" in a title is a
  // default, not evidence against a type somebody set.
  const typeLevel = !renamed && fleetNow !== null && !typeLocked;
  if ((typeEdge || typeLevel) && profile.driver_type !== wantType) {
    patch.driver_type = wantType;
    patch.driver_type_source = 'bot';
    changed.push('driver_type');
  }

  const inactiveNow = nameMarkedInactive(title);
  const current = profile.status || 'active';
  if (renamed && nameMarkedInactive(previousName) !== inactiveNow) {
    const want = inactiveNow ? 'inactive' : 'active';
    if (current !== want) {
      patch.status = want;
      changed.push('status');
    }
  } else if (!renamed && inactiveNow && current === 'active' && statusSource !== 'manual') {
    patch.status = 'inactive';
    changed.push('status');
  }
  return { patch, changed };
}

module.exports = { profilePatchFromTitle };
