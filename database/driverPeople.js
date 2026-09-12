/**
 * The person identity layer — façade.
 *
 * A driver is a PERSON. A Telegram group, a truck and a Samsara vehicle are
 * things that person is associated with over a period of time, and changing any
 * of them must not create a new human or reset a clock.
 *
 * Composition only, per CLAUDE.md → Module design. The keys are listed
 * explicitly rather than spread, so the public surface is a decision rather
 * than whatever the internals happen to export today.
 *
 *   ./driverPeople/people.js        the person row and the merge pointer
 *   ./driverPeople/associations.js  person ↔ group and person ↔ truck, in time
 *
 *   ./driverPeople/lookups.js       what the resolver asks, and the bulk stamps
 *   ./driverPeople/telegramIdentities.js  which Telegram account is this human
 *
 * Written by `services/identity/personResolver.js` (the bot's capture path and
 * the profile-save hook) and read through the `person_id` columns migration
 * 0026 put on the operational tables.
 */
const people = require('./driverPeople/people');
const associations = require('./driverPeople/associations');
const lookups = require('./driverPeople/lookups');
const telegramIdentities = require('./driverPeople/telegramIdentities');

module.exports = {
  // people
  MAX_MERGE_DEPTH: people.MAX_MERGE_DEPTH,
  createPerson: people.createPerson,
  getPersonById: people.getPersonById,
  resolveCanonicalPerson: people.resolveCanonicalPerson,
  findPeopleByNormalizedKey: people.findPeopleByNormalizedKey,
  listPeople: people.listPeople,
  updatePerson: people.updatePerson,
  mergePerson: people.mergePerson,
  unmergePerson: people.unmergePerson,

  // associations
  openGroupAssociation: associations.openGroupAssociation,
  closeGroupAssociation: associations.closeGroupAssociation,
  getOpenAssociationForGroup: associations.getOpenAssociationForGroup,
  listGroupsForPerson: associations.listGroupsForPerson,
  getPersonIdForGroup: associations.getPersonIdForGroup,
  openUnitAssignment: associations.openUnitAssignment,
  closeUnitAssignment: associations.closeUnitAssignment,
  getOpenUnitForPerson: associations.getOpenUnitForPerson,
  getOpenPersonForUnit: associations.getOpenPersonForUnit,
  getOpenHoldersForUnit: associations.getOpenHoldersForUnit,
  getOpenPeopleForUnits: associations.getOpenPeopleForUnits,
  listUnitsForPerson: associations.listUnitsForPerson,

  // lookups
  findPersonByTelegramUserId: lookups.findPersonByTelegramUserId,

  // telegram identities — which account is this HUMAN, over time
  openTelegramIdentity: telegramIdentities.openTelegramIdentity,
  closeTelegramIdentity: telegramIdentities.closeTelegramIdentity,
  findPersonByTelegramIdentity: telegramIdentities.findPersonByTelegramIdentity,
  listTelegramIdentitiesForPerson: telegramIdentities.listTelegramIdentitiesForPerson,
  listLinkedTelegramUserIds: telegramIdentities.listLinkedTelegramUserIds,
  summariseTelegramIdentities: telegramIdentities.summariseTelegramIdentities,
  findReturningCandidates: lookups.findReturningCandidates,
  stampPersonIdForGroup: lookups.stampPersonIdForGroup,
  stampAllFromAssociations: lookups.stampAllFromAssociations,
  getPersonIdentity: lookups.getPersonIdentity,
  summariseIdentityCoverage: lookups.summariseIdentityCoverage,
};
