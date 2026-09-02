/**
 * Facebook leads infrastructure — database façade.
 *
 * RE-EXPORT ONLY. `database/db.js` spreads this module and several services
 * import it directly, so the path stays the stable public seam while the
 * queries live in focused modules grouped by the table family they own:
 *
 *   ./facebookLeads/connectSessions.js  token-gated /connect OAuth sessions
 *   ./facebookLeads/pageConnections.js  connected Pages + encrypted tokens
 *   ./facebookLeads/webhookEvents.js    the verified-event queue and its guards
 *   ./facebookLeads/autoMessages.js     admin-editable auto-SMS config
 *   ./facebookLeads/smsMirrors.js       the two-way SMS mirror ledger
 *
 * Nothing but re-exports belongs here — see CLAUDE.md → Module design.
 */
const connectSessions = require('./facebookLeads/connectSessions');
const pageConnections = require('./facebookLeads/pageConnections');
const webhookEvents = require('./facebookLeads/webhookEvents');
const autoMessages = require('./facebookLeads/autoMessages');
const smsMirrors = require('./facebookLeads/smsMirrors');

module.exports = {
  ...connectSessions,
  ...pageConnections,
  ...webhookEvents,
  ...autoMessages,
  ...smsMirrors,
};
