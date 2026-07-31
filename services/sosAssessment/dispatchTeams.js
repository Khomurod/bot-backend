/**
 * The SOS assessment's dispatch teams — the single authoritative list.
 *
 * These SIX teams are the only choices offered on /questions and /questions/test,
 * the only values accepted by a submission, and the vocabulary used everywhere
 * downstream (admin list, detail, CSV export, /answers and /answers/test
 * department and team summaries, filters).
 *
 * DELIBERATELY NOT the `dispatch_teams` table. That table belongs to Raise
 * Approval / Driver Groups; its rows are unrelated operational records that came
 * and went independently of this questionnaire, and `sos_submissions`
 * .dispatch_team_id carries a FOREIGN KEY to it. So SOS submissions store
 * dispatch_team_id = NULL and identify the team by its exact snapshotted NAME in
 * dispatch_team_name. That keeps the two lists from ever mixing, needs no schema
 * change, and leaves the Raise Approval feature untouched.
 *
 * `key` is the stable identifier sent over the wire (a rename would keep history
 * resolvable); `name` is the exact display text, byte-for-byte the same in every
 * surface; `position` fixes the presentation order.
 */

const SOS_DISPATCH_TEAMS = Object.freeze([
  { key: 'team_1', position: 1, name: 'Anthony / Allen / Scott' },
  { key: 'team_2', position: 2, name: 'Charles / Leo / Steven' },
  { key: 'team_3', position: 3, name: 'Smith / Colin / Kevin' },
  { key: 'team_4', position: 4, name: 'Franky / Sam / Ali' },
  { key: 'team_5', position: 5, name: 'Tony / Andy / Max' },
  { key: 'team_6', position: 6, name: 'Aaron / Jack' },
].map((team) => Object.freeze(team)));

const BY_KEY = new Map(SOS_DISPATCH_TEAMS.map((team) => [team.key, team]));
const BY_NAME = new Map(SOS_DISPATCH_TEAMS.map((team) => [team.name, team]));

/** The public shape sent to the questionnaire, in canonical order. */
function publicDispatchTeams() {
  return SOS_DISPATCH_TEAMS.map((team) => ({ key: team.key, name: team.name }));
}

/** Resolves a wire key to its team, or null for anything unknown. */
function findDispatchTeamByKey(key) {
  if (typeof key !== 'string') return null;
  return BY_KEY.get(key.trim()) || null;
}

/** Resolves an exact stored name back to its team (null for legacy names). */
function findDispatchTeamByName(name) {
  if (typeof name !== 'string') return null;
  return BY_NAME.get(name) || null;
}

/**
 * Canonical sort position for a stored team name. Unknown names (rows submitted
 * before this list existed) sort after all six rather than being dropped —
 * history is preserved, but it can never become a selectable choice.
 */
function dispatchTeamOrder(name) {
  const team = findDispatchTeamByName(name);
  return team ? team.position : Number.MAX_SAFE_INTEGER;
}

module.exports = {
  SOS_DISPATCH_TEAMS,
  publicDispatchTeams,
  findDispatchTeamByKey,
  findDispatchTeamByName,
  dispatchTeamOrder,
};
