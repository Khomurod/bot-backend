'use strict';

/**
 * Put the app secrets into process.env — the FIRST thing a production
 * entrypoint does, before config/config.js is ever required.
 *
 * Settings → System → Secrets stores the deployment's settings in the database
 * (docs/architecture/app-secrets.md); Coolify keeps only DATABASE_URL and
 * INTEGRATION_SECRET_KEY. Every module reads its settings from process.env, and
 * config/config.js reads them the moment it is loaded, so the stored values
 * have to be there before anything else runs. The read is asynchronous and this
 * must not be, so it happens in a child process (config/appSecretsFetch.js)
 * that is waited for.
 *
 * RULES:
 *   - A stored value OVERRIDES the same name in Coolify. That is what lets the
 *     owner empty Coolify one name at a time without a gap.
 *   - Anything that goes wrong leaves process.env exactly as Coolify set it and
 *     says so in one log line. If a required value then turns out missing,
 *     config's own startup check stops the process with its usual message —
 *     and Docker starts it again.
 *   - APP_SECRETS_OFF=true (in Coolify) skips the read entirely;
 *     APP_SECRETS_VERSION=<id> loads that older version — the way back when a
 *     saved version stops the app from starting.
 *   - No value is ever logged. Names and a version number are.
 *
 * The values Coolify had before the override are kept (in memory, never
 * returned by any API) so a save can check "would the app still start?"
 * against what Coolify itself provides.
 */
const path = require('path');
const { execFileSync } = require('child_process');

const FETCH_TIMEOUT_MS = 40_000;

const state = {
  status: 'not-run',
  reason: null,
  version: null,
  names: [],
  overridden: [],
  hostEnv: null,
};

function isOn(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function runFetch(target, env) {
  const out = execFileSync(process.execPath, [path.join(__dirname, 'appSecretsFetch.js'), target], {
    env,
    encoding: 'utf8',
    timeout: FETCH_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  const line = String(out || '').trim().split('\n').pop();
  return JSON.parse(line);
}

/**
 * @param {'bot'} target
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]   the environment to read from and write into
 * @param {Function} [opts.fetch]          (target, env) => result — tests
 * @param {Console} [opts.log]
 */
function loadAppSecrets(target, { env = process.env, fetch = runFetch, log = console } = {}) {
  state.hostEnv = { ...env };
  if (isOn(env.APP_SECRETS_OFF)) {
    Object.assign(state, { status: 'off', reason: 'APP_SECRETS_OFF is set in Coolify' });
    log.warn('[Secrets] APP_SECRETS_OFF is set — using only the Coolify environment.');
    return state;
  }

  let result;
  try {
    result = fetch(target, env);
  } catch (err) {
    result = { status: 'failed', reason: err && err.code === 'ETIMEDOUT' ? 'the read timed out' : 'the read could not run' };
  }

  if (!result || result.status !== 'loaded') {
    const status = result && result.status === 'skipped' ? 'skipped' : 'failed';
    const reason = (result && result.reason) || 'no answer';
    Object.assign(state, { status, reason, version: null, names: [], overridden: [] });
    const say = status === 'skipped' ? log.log : log.error;
    say.call(log, `[Secrets] Not loaded from the app (${reason}) — using the Coolify environment.`);
    return state;
  }

  const names = Object.keys(result.values).sort();
  const overridden = names.filter((name) => env[name] !== undefined && env[name] !== result.values[name]);
  for (const name of names) env[name] = result.values[name];
  Object.assign(state, { status: 'loaded', reason: null, version: result.version, names, overridden });
  log.log(
    `[Secrets] Loaded ${names.length} setting(s) from the app (version ${result.version}`
    + `${env.APP_SECRETS_VERSION ? ', pinned by APP_SECRETS_VERSION' : ''})`
    + `${overridden.length ? `; overriding Coolify for ${overridden.join(', ')}` : ''}.`,
  );
  return state;
}

/**
 * The entrypoint call: a local .env (development) first, exactly as
 * config/config.js would load it, then the stored secrets over it.
 */
function bootAppSecrets(target) {
  require('dotenv').config();
  return loadAppSecrets(target);
}

/** What the boot did — for Settings → Secrets. Never a value. */
function getBootState() {
  return {
    status: state.status,
    reason: state.reason,
    version: state.version,
    names: [...state.names],
    overridden: [...state.overridden],
    // APP_SECRETS_VERSION in Coolify: every start loads THAT version, not the newest.
    pinned: Boolean(String((state.hostEnv || {}).APP_SECRETS_VERSION || '').trim()),
  };
}

/** The environment as Coolify set it, before the override (empty before boot). */
function getHostEnv() {
  return { ...(state.hostEnv || {}) };
}

module.exports = { bootAppSecrets, loadAppSecrets, getBootState, getHostEnv };
