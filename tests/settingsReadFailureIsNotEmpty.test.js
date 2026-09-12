'use strict';

/**
 * A database failure is not "nothing configured".
 *
 * Six single-row settings modules used to catch EVERY error from their read and
 * answer null, on the stated grounds that "the table may not exist yet on a
 * brand-new database before initializeDatabase ran".
 *
 * THAT CASE CANNOT OCCUR. `initializeDatabase()` applies schema.sql and the
 * migrations before the server listens and before the bot starts, and no boot
 * path reads these settings. So the catch protected against nothing, while
 * costing the one distinction that matters during an outage — and the costs are
 * concrete: BOL/POD forwarding reads as OFF and a driver's paperwork is not
 * delivered; a message category resolves to no destination; the Samsara key
 * falls back to the environment; route geometry reads as switched off.
 *
 * `database/dispatchBoardSettings.js` already reads this way, with the rule
 * quoted from APP_BRIEF §9: a failure is never rendered as empty data. This
 * holds the other six to the same standard, and holds the SEVENTH to it too so
 * the precedent cannot quietly regress.
 *
 * Each module is loaded with `database/db.js` replaced by a stub that throws,
 * which is the only way to reach the path in question.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const DB_PATH = require.resolve('../database/db');

/** Every module here reads one row and must not turn a failure into "empty". */
const MODULES = [
  { file: 'samsaraSettings', getter: 'getSamsaraConfig', admin: 'getSamsaraSettingsForAdmin' },
  { file: 'eldSettings', getter: 'getEldConfig', admin: 'getEldSettingsForAdmin' },
  { file: 'gmapsSettings', getter: 'getGmapsConfig', admin: 'getGmapsSettingsForAdmin' },
  { file: 'bolPodForwardingSettings', getter: 'getBolPodConfig', admin: 'getBolPodSettingsForAdmin' },
  { file: 'messageRoutingSettings', getter: 'getMessageGroupConfig', admin: 'getMessageGroupSettingsForAdmin' },
  { file: 'safetyEventVideoSettings', getter: 'getSafetyEventVideoConfig', admin: 'getSafetyEventVideoSettingsForAdmin' },
  // The precedent. Included so it cannot regress into the old shape.
  { file: 'dispatchBoardSettings', getter: 'getBoardConfig', admin: 'getBoardSettingsForAdmin' },
];

/** Errors a hosted Postgres actually produces, none of which is a missing table. */
const FAILURES = [
  { code: '57P01', message: 'terminated by administrator command', what: 'the server went away' },
  { code: '53300', message: 'too many connections for role', what: 'out of connections' },
  { code: '42501', message: 'permission denied for table', what: 'permission revoked' },
  { code: '53400', message: 'configuration limit exceeded', what: 'a usage limit' },
  { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED', what: 'unreachable' },
  { code: undefined, message: 'Client has encountered a connection error', what: 'a pool error' },
];

function loadWith(moduleFile, thrower) {
  const modPath = require.resolve(`../database/${moduleFile}`);
  delete require.cache[modPath];
  delete require.cache[DB_PATH];
  require.cache[DB_PATH] = {
    exports: {
      query: async () => { throw thrower(); },
      pool: {},
      ping: async () => false,
    },
  };
  const mod = require(modPath);
  mod.invalidateCache?.();
  return mod;
}

/**
 * Resolve a getter by name, refusing to continue if it is not there.
 *
 * Without this a renamed export makes `mod[getter]()` throw a TypeError, which
 * `assert.rejects` accepts — the test would go green while exercising nothing.
 * It caught exactly that on the first run.
 */
function getterOf(mod, name, file) {
  assert.equal(typeof mod[name], 'function', `${file} has no ${name} to test`);
  return mod[name];
}

function cleanup() {
  delete require.cache[DB_PATH];
  for (const { file } of MODULES) delete require.cache[require.resolve(`../database/${file}`)];
}

for (const { file, getter, admin } of MODULES) {
  for (const failure of FAILURES) {
    test(`${file}.${getter} rejects when ${failure.what}`, async (t) => {
      t.after(cleanup);
      const mod = loadWith(file, () => Object.assign(new Error(failure.message), { code: failure.code }));
      const fn = getterOf(mod, getter, file);
      await assert.rejects(
        () => fn(),
        (err) => {
          // It must be the failure itself reaching the caller, not a
          // substitute, and never a resolved "nothing configured".
          assert.equal(err.message, failure.message);
          return true;
        },
        `${file}.${getter} answered instead of reporting ${failure.what}`,
      );
    });
  }

  test(`${file}.${admin} rejects rather than showing an empty form`, async (t) => {
    t.after(cleanup);
    const mod = loadWith(file, () => Object.assign(new Error('server closed the connection'), { code: '57P01' }));
    // The admin read is the one a person looks at. Answering 200 with "off and
    // unconfigured" is the lie the route is supposed to turn into a 500.
    const fn = getterOf(mod, admin, file);
    await assert.rejects(() => fn());
  });
}

test('no settings module is left catching everything', async (t) => {
  t.after(cleanup);
  // A structural check, so a future module cannot quietly reintroduce the
  // shape: none of these files may swallow an error from the settings read and
  // return null in its place.
  const fs = require('node:fs');
  for (const { file } of MODULES) {
    const src = fs.readFileSync(path.resolve(__dirname, `../database/${file}.js`), 'utf8');
    const swallows = /catch \([^)]*\) \{[^}]*unavailable[^}]*return null;/s.test(src);
    assert.equal(swallows, false, `${file}.js still turns a read failure into null`);
  }
});
