/**
 * Deciding WHO the people are — pure, no I/O.
 *
 * Given every active driver group and its profile, work out how many humans
 * that is. The whole point of keeping this pure is that the decision can be
 * tested against the real production shapes (unit '001' on four groups; the
 * RUSLAN ABDULLAEV twin pair) without a database and without writing anything.
 *
 * Three rules, in descending order of evidence, and the gap between them is the
 * design:
 *
 *   1. A shared `driver_profiles.telegram_user_id` is a HARD anchor — the same
 *      Telegram account texted in both chats. Those groups are one person, and
 *      the backfill links them without asking.
 *   2. A shared normalized NAME is a guess. Two humans really do normalize
 *      alike; treating that as identity is the bug that already exists in
 *      mileage_bonus_progress. These are emitted as CANDIDATES and never merged.
 *   3. A unit number claimed by more than one person is a contradiction, not a
 *      tie to break. Neither claim is recorded and both are reported. Picking
 *      one arbitrarily would invent a fact.
 */
const { buildNormalizedDriverKey, buildDriverDisplayName } = require('../../lib/drivers/driverProfileParse');

/** Union-Find over group ids — the clustering that turns groups into people. */
function createClusters(ids) {
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (id) => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root);
    // Path-compress so a long chain does not cost the next lookup.
    let cursor = id;
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor);
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  const union = (a, b) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  };
  return { find, union };
}

function personFieldsFor(row) {
  return {
    first_name: row.first_name,
    last_name: row.last_name,
    secondary_first_name: row.secondary_first_name,
    secondary_last_name: row.secondary_last_name,
    fallbackGroupName: row.group_name,
  };
}

/**
 * @param {Array} rows  one per active driver group:
 *   { group_id, group_name, first_name, last_name, secondary_first_name,
 *     secondary_last_name, unit_number, telegram_user_id, date_of_birth }
 * @returns {{people: Array, mergeCandidates: Array, contestedUnits: Array, stats: object}}
 */
function planPersonBackfill(rows = []) {
  const groups = rows.filter((row) => row && row.group_id != null);
  const { find, union } = createClusters(groups.map((row) => row.group_id));

  // Rule 1 — the hard anchor. Same Telegram account in two chats is one human.
  const byTelegramUser = new Map();
  for (const row of groups) {
    const tgId = row.telegram_user_id;
    if (tgId == null || tgId === '') continue;
    const key = String(tgId);
    if (byTelegramUser.has(key)) union(byTelegramUser.get(key), row.group_id);
    else byTelegramUser.set(key, row.group_id);
  }

  // Build one person per cluster.
  const clusters = new Map();
  for (const row of groups) {
    const root = find(row.group_id);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(row);
  }

  const people = [];
  for (const [root, members] of clusters) {
    // The newest group is the most current spelling of the person's name.
    const ordered = [...members].sort((a, b) => b.group_id - a.group_id);
    const primary = ordered[0];
    const anchored = members.length > 1;
    people.push({
      key: root,
      displayName: buildDriverDisplayName(personFieldsFor(primary)) || primary.group_name || `Group ${primary.group_id}`,
      normalizedKey: buildNormalizedDriverKey(personFieldsFor(primary)),
      dateOfBirth: ordered.find((row) => row.date_of_birth)?.date_of_birth || null,
      groups: ordered.map((row) => ({
        groupId: row.group_id,
        groupName: row.group_name,
        // Only a cluster of more than one group was actually JOINED by evidence;
        // a singleton is just this group, so calling it 'telegram_user_id' would
        // overstate how it was decided.
        associationSource: anchored ? 'telegram_user_id' : 'backfill',
        confidence: anchored ? 100 : 80,
      })),
      unitNumber: ordered.map((row) => row.unit_number).find((unit) => unit && String(unit).trim()) || null,
    });
  }

  // Rule 3 — a unit claimed by more than one person is left unclaimed.
  const unitClaims = new Map();
  for (const person of people) {
    if (!person.unitNumber) continue;
    const unit = String(person.unitNumber).trim();
    if (!unitClaims.has(unit)) unitClaims.set(unit, []);
    unitClaims.get(unit).push(person);
  }
  const contestedUnits = [];
  for (const [unit, claimants] of unitClaims) {
    if (claimants.length < 2) continue;
    contestedUnits.push({
      unitNumber: unit,
      people: claimants.map((person) => ({
        personKey: person.key,
        displayName: person.displayName,
        groupIds: person.groups.map((g) => g.groupId),
      })),
    });
    for (const person of claimants) person.unitNumber = null;
  }

  // Rule 2 — a shared name is a candidate, never a merge.
  const byNameKey = new Map();
  for (const person of people) {
    if (!person.normalizedKey) continue;
    if (!byNameKey.has(person.normalizedKey)) byNameKey.set(person.normalizedKey, []);
    byNameKey.get(person.normalizedKey).push(person);
  }
  const mergeCandidates = [];
  for (const [normalizedKey, candidates] of byNameKey) {
    if (candidates.length < 2) continue;
    mergeCandidates.push({
      normalizedKey,
      people: candidates.map((person) => ({
        personKey: person.key,
        displayName: person.displayName,
        groupIds: person.groups.map((g) => g.groupId),
      })),
    });
  }

  return {
    people,
    mergeCandidates,
    contestedUnits,
    stats: {
      groups: groups.length,
      people: people.length,
      anchoredClusters: people.filter((p) => p.groups.length > 1).length,
      unitsClaimed: people.filter((p) => p.unitNumber).length,
      contestedUnits: contestedUnits.length,
      mergeCandidates: mergeCandidates.length,
      peopleWithoutNameKey: people.filter((p) => !p.normalizedKey).length,
    },
  };
}

module.exports = { planPersonBackfill, createClusters };
