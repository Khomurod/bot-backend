/**
 * 75¢/mile Driver Raise Approval — database façade.
 *
 * RE-EXPORT ONLY. Routes and services import `database/raiseApproval`, so the
 * path stays the stable public seam while the queries live in focused modules
 * grouped by what they own:
 *
 *   ./raiseApproval/settings.js     the settings row, incl. next_run_at
 *   ./raiseApproval/teams.js        dispatch teams
 *   ./raiseApproval/teamMembers.js  the people, and the username → team lookups
 *   ./raiseApproval/teamDrivers.js  driver assignments (one active team each)
 *   ./raiseApproval/rounds.js       rounds, submissions and picks (transactional)
 *   ./raiseApproval/otp.js          dispatcher passcodes and rate-limit inputs
 *
 * Nothing but re-exports belongs here — see CLAUDE.md → Module design.
 */
const settings = require('./raiseApproval/settings');
const teams = require('./raiseApproval/teams');
const teamMembers = require('./raiseApproval/teamMembers');
const teamDrivers = require('./raiseApproval/teamDrivers');
const rounds = require('./raiseApproval/rounds');
const otp = require('./raiseApproval/otp');

module.exports = {
  ...settings,
  ...teams,
  ...teamMembers,
  ...teamDrivers,
  ...rounds,
  ...otp,
};
