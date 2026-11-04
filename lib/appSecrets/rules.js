'use strict';

/**
 * What may be stored as an app secret, who reads it, and what an upload
 * changes — pure, no I/O. The decisions are the owner's, November 2026; the
 * reasons are in docs/architecture/app-secrets.md.
 *
 * TWO READERS, ONE TABLE. Every value has a scope:
 *   'both'    — the same name means the same thing in this app and in the
 *               Samsara service (BOT_TOKEN is the one main bot both post with),
 *               so it is stored once and a change reaches both;
 *   'bot'     — this app only;
 *   'samsara' — the Samsara service only.
 * An upload names its TARGET ('bot' or 'samsara'). A shared name always lands
 * in 'both'; every other name lands in the target's own scope. A name that
 * means different things in the two services (TELEGRAM_BOT_TOKEN is the leads
 * bot here and a fallback for the Samsara bot there; PORT, USE_WEBHOOK, the
 * webhook URLs) is never shared.
 */

const TARGETS = Object.freeze(['bot', 'samsara']);

/** Must stay in Coolify: they are what reaches and opens the table, or pin it. */
const HOST_ONLY = Object.freeze([
  'DATABASE_URL',
  'INTEGRATION_SECRET_KEY',
  'PORT',
  'APP_SECRETS_VERSION',
  'APP_SECRETS_OFF',
]);

/** Set by the platform itself, never by a person. */
const PLATFORM_PREFIXES = Object.freeze(['COOLIFY_', 'SERVICE_FQDN_', 'SERVICE_URL_']);
const PLATFORM_NAMES = Object.freeze(['SOURCE_COMMIT', 'HOSTNAME', 'HOME', 'PATH']);

/** Same meaning in both services — stored once, scope 'both'. */
const SHARED_NAMES = Object.freeze(['BOT_TOKEN', 'SAMSARA_API_KEY', 'MANAGEMENT_GROUP_ID', 'EMPLOYEE_GROUP_ID']);
const SHARED_PREFIXES = Object.freeze(['GEMINI_', 'GROQ_']);

/** Read nowhere in the target, so not stored there (with the reason shown). */
const NOT_NEEDED = Object.freeze({
  samsara: Object.freeze({
    TELEGRAM_BOT_TOKEN: 'not needed by the Samsara service — it uses SAMSARA_BOT_TOKEN',
  }),
  bot: Object.freeze({}),
});

/**
 * What each service cannot start without. For 'bot' it is config/config.js's
 * own list (a test pins the two together); a missing one blocks a save, because
 * the app would not come back up. For 'samsara' a missing one is a warning:
 * this app cannot see the Samsara service's own Coolify environment.
 */
const REQUIRED = Object.freeze({
  bot: Object.freeze(['JWT_SECRET', 'BOT_TOKEN', 'TELEGRAM_BOT_TOKEN', 'FACEBOOK_TOKEN_ENCRYPTION_KEY']),
  samsara: Object.freeze(['SAMSARA_BOT_TOKEN', 'BOT_TOKEN']),
});

/** The three Telegram bots. One token per bot: two pollers on one token is a 409. */
const TOKEN_NAMES = Object.freeze(['BOT_TOKEN', 'TELEGRAM_BOT_TOKEN', 'SAMSARA_BOT_TOKEN']);

function isTarget(value) {
  return TARGETS.includes(value);
}

/** Why a name is not stored, or null when it may be. */
function skipReason(name, target) {
  if (HOST_ONLY.includes(name)) return 'stays in Coolify';
  if (PLATFORM_NAMES.includes(name) || PLATFORM_PREFIXES.some((p) => name.startsWith(p))) return 'set by the platform';
  const notNeeded = NOT_NEEDED[target] && NOT_NEEDED[target][name];
  if (notNeeded) return notNeeded;
  return null;
}

function scopeFor(name, target) {
  if (SHARED_NAMES.includes(name) || SHARED_PREFIXES.some((p) => name.startsWith(p))) return 'both';
  return target;
}

/** The scopes a service reads, in the order a later one overrides an earlier one. */
function scopesReadBy(target) {
  return ['both', target];
}

/** The last four characters — only for values long enough that four reveal little. */
function last4(value) {
  const text = String(value || '');
  return text.length >= 12 ? text.slice(-4) : '';
}

const keyOf = (scope, name) => `${scope}\u0000${name}`;

/**
 * What saving `entries` for `target` would store.
 *
 * Replacement for the target's own scope (a name it held that the file lacks
 * is removed); for 'both' only additions and changes — a file for one service
 * never removes a value the other one reads. Values of the other target are
 * carried over untouched.
 *
 * @param {object} input
 * @param {'bot'|'samsara'} input.target
 * @param {{name: string, value: string}[]} input.entries   parsed file
 * @param {{scope: string, name: string, value: string}[]} input.current
 * @returns {{
 *   items: {scope: string, name: string, value: string}[],
 *   added: {scope: string, name: string}[],
 *   changed: {scope: string, name: string}[],
 *   removed: {scope: string, name: string}[],
 *   unchanged: number,
 *   skipped: {name: string, reason: string}[],
 * }}
 */
function planUpload({ target, entries, current }) {
  if (!isTarget(target)) throw new Error(`Unknown target "${target}"`);
  const before = new Map(current.map((c) => [keyOf(c.scope, c.name), c]));
  const next = new Map();
  for (const c of current) {
    if (c.scope !== target) next.set(keyOf(c.scope, c.name), { scope: c.scope, name: c.name, value: c.value });
  }

  const skipped = [];
  for (const { name, value } of entries) {
    const reason = skipReason(name, target);
    if (reason) { skipped.push({ name, reason }); continue; }
    if (value === '') { skipped.push({ name, reason: 'empty value — not stored' }); continue; }
    const scope = scopeFor(name, target);
    next.set(keyOf(scope, name), { scope, name, value });
  }

  const added = [];
  const changed = [];
  const removed = [];
  let unchanged = 0;
  for (const [key, item] of next) {
    const old = before.get(key);
    if (!old) added.push({ scope: item.scope, name: item.name });
    else if (old.value !== item.value) changed.push({ scope: item.scope, name: item.name });
    else unchanged += 1;
  }
  for (const [key, old] of before) {
    if (!next.has(key)) removed.push({ scope: old.scope, name: old.name });
  }

  const byName = (a, b) => (a.name === b.name ? a.scope.localeCompare(b.scope) : a.name.localeCompare(b.name));
  return {
    items: [...next.values()].sort(byName),
    added: added.sort(byName),
    changed: changed.sort(byName),
    removed: removed.sort(byName),
    unchanged,
    skipped,
  };
}

/** The values one service would see: 'both' first, its own scope over it. */
function effectiveValues(items, target) {
  const out = {};
  for (const scope of scopesReadBy(target)) {
    for (const item of items) if (item.scope === scope) out[item.name] = item.value;
  }
  return out;
}

/**
 * Problems that must stop a save, and warnings that must not.
 *
 * @param {object} input
 * @param {{scope: string, name: string, value: string}[]} input.items  the version to be saved
 * @param {Record<string, string>} input.hostEnv  this app's own Coolify values (bot target)
 */
function checkVersion({ items, hostEnv = {} }) {
  const blocking = [];
  const warnings = [];

  const bot = { ...hostEnv, ...effectiveValues(items, 'bot') };
  for (const name of REQUIRED.bot) {
    if (!String(bot[name] || '').trim()) blocking.push(`${name} is missing — this app cannot start without it`);
  }
  const samsara = effectiveValues(items, 'samsara');
  const samsaraStored = items.some((i) => i.scope === 'samsara');
  if (samsaraStored) {
    for (const name of REQUIRED.samsara) {
      if (!String(samsara[name] || '').trim()) warnings.push(`${name} is not stored for the Samsara service — it must still be set in its Coolify`);
    }
  }

  const tokens = [
    ['BOT_TOKEN', bot.BOT_TOKEN],
    ['TELEGRAM_BOT_TOKEN', bot.TELEGRAM_BOT_TOKEN],
    ['SAMSARA_BOT_TOKEN', samsara.SAMSARA_BOT_TOKEN],
  ].filter(([, v]) => String(v || '').trim());
  for (let i = 0; i < tokens.length; i += 1) {
    for (let j = i + 1; j < tokens.length; j += 1) {
      if (tokens[i][1].trim() === tokens[j][1].trim()) {
        blocking.push(`${tokens[i][0]} and ${tokens[j][0]} are the same token — each bot needs its own`);
      }
    }
  }
  return { blocking, warnings };
}

module.exports = {
  TARGETS,
  HOST_ONLY,
  SHARED_NAMES,
  SHARED_PREFIXES,
  REQUIRED,
  TOKEN_NAMES,
  isTarget,
  skipReason,
  scopeFor,
  scopesReadBy,
  last4,
  planUpload,
  effectiveValues,
  checkVersion,
};
