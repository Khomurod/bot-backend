'use strict';

/**
 * Keeps a driver profile in line with its chat's title
 * (lib/drivers/titleSync.js says what, and when).
 *
 *   onGroupRenamed  — called by the bot when a chat's stored title changes;
 *   reconcileTitles — one pass at startup over every driver group, which also
 *                     corrects the profiles that drifted before this existed.
 *
 * Writes go through database/driverProfiles.js updateDriverProfile, which also
 * moves `groups.active` with the status (source 'bot'), exactly as the AI sync
 * and the admin page do. Never throws: a profile that cannot be updated is
 * logged by id and left for the next rename or restart.
 */

const db = require('../database/db');
const { profilePatchFromTitle } = require('../lib/drivers/titleSync');

function log(text) {
  console.log(`[DRIVER-TITLE] ${text}`);
}

async function apply(profile, group, previousName) {
  const { patch, changed } = profilePatchFromTitle(profile, {
    title: group.group_name,
    previousName,
    statusSource: group.status_source ?? profile.status_source ?? null,
  });
  if (!changed.length) return null;
  await db.updateDriverProfile(profile.id, patch, {
    groupStatusSource: patch.status ? 'bot' : null,
  });
  return changed;
}

/** A chat's title changed. Never throws. */
async function onGroupRenamed(group, previousName) {
  try {
    if (!group?.id || group.group_type !== 'driver') return null;
    const profile = await db.getDriverProfileByGroupId(group.id);
    if (!profile) return null;
    const changed = await apply(profile, group, previousName);
    if (changed) log(`group ${group.id} renamed: ${changed.join(', ')} follows the new title`);
    return changed;
  } catch (err) {
    log(`group ${group?.id} rename could not be applied: ${err.message}`);
    return null;
  }
}

/** Every driver profile up to what its title says now. Never throws. */
async function reconcileTitles() {
  try {
    const profiles = await db.listDriverProfiles({ includeInactive: true });
    let updated = 0;
    for (const profile of profiles) {
      if (profile.group_type && profile.group_type !== 'driver') continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        const changed = await apply(profile, { group_name: profile.group_name, status_source: profile.status_source }, undefined);
        if (changed) updated += 1;
      } catch (err) {
        log(`profile ${profile.id} could not be reconciled: ${err.message}`);
      }
    }
    if (updated) log(`${updated} driver profile(s) brought in line with their chat titles`);
    return updated;
  } catch (err) {
    log(`reconcile failed: ${err.message}`);
    return 0;
  }
}

module.exports = { onGroupRenamed, reconcileTitles };
