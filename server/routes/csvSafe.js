'use strict';

/**
 * CSV serialization that is safe against spreadsheet formula injection (§10).
 *
 * THE IMPLEMENTATION MOVED to `admin/src/utils/csvSafe.js` and this re-exports
 * it, because the only CSV this application produces is built in the BROWSER
 * (Settings → Bot Group Access) and it was using an unsafe local copy. Two
 * implementations of an injection guard is one implementation and one hole;
 * `utils/birthdaySort.js` already established the direction for a helper both
 * sides need.
 *
 * Kept at this path so `tests/checkImports.test.js`, which reads this file by
 * name, and any future server-side export still find it.
 */
module.exports = require('../../admin/src/utils/csvSafe.js');
