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
 * NOTHING in the application reads this yet. The layer is deliberately inert
 * until a later stage wires it in, so adding it cannot change any behaviour.
 */
const people = require('./driverPeople/people');
const associations = require('./driverPeople/associations');

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
  listUnitsForPerson: associations.listUnitsForPerson,
};
