'use strict';

/**
 * Settings → System → Secrets: what the page shows, what an upload would
 * change, and the save — docs/architecture/app-secrets.md.
 *
 * WHAT NEVER HAPPENS HERE:
 *   - a value is returned, logged, or put in an error. The page sees names,
 *     scopes and the last four characters of long values; nothing else;
 *   - a value is encrypted with anything but INTEGRATION_SECRET_KEY. Without
 *     it set in Coolify there is nothing to save with, and the page says so;
 *   - a version is saved that this app could not start with (a required
 *     value missing, two bots sharing one token, a token Telegram refuses).
 *
 * Every save writes a NEW version; the app restarts itself to read it (the
 * route does that, after answering). Unchanged values keep their exact
 * ciphertext, so the Samsara service can tell when its own values changed.
 */
const sharedCrypto = require('../../lib/security/sharedIntegrationCrypto');
const rules = require('../../lib/appSecrets/rules');
const { parseEnvText } = require('../../lib/appSecrets/envFile');
const store = require('../../database/appSecrets');
const boot = require('../../config/appSecretsBoot');
const { checkTelegramToken } = require('./telegramTokenCheck');

const MAX_TEXT_BYTES = 200 * 1024;
const MAX_ENTRIES = 400;

function badRequest(message, extra = {}) {
  return Object.assign(new Error(message), { statusCode: 400, ...extra });
}
function conflict(message) {
  return Object.assign(new Error(message), { statusCode: 409 });
}

/** Only the explicit key, from Coolify — never the DATABASE_URL-derived one. */
function keyEnv(env = process.env) {
  const key = String(boot.getHostEnv().INTEGRATION_SECRET_KEY || env.INTEGRATION_SECRET_KEY || '').trim();
  return key ? { INTEGRATION_SECRET_KEY: key } : null;
}

function hostEnv() {
  return boot.getBootState().status === 'not-run' ? { ...process.env } : boot.getHostEnv();
}

function createSecretsService(deps = {}) {
  const db = deps.store || store;
  const tokenCheck = deps.checkTelegramToken || checkTelegramToken;
  const getKeyEnv = deps.keyEnv || keyEnv;
  const getHostEnv = deps.hostEnv || hostEnv;
  const bootState = deps.bootState || boot.getBootState;

  function requireKey() {
    const env = getKeyEnv();
    if (!env) {
      throw conflict('INTEGRATION_SECRET_KEY is not set in Coolify. Add the same value to both apps there first, then come back.');
    }
    return env;
  }

  /** The version in use, opened: [{scope, name, value, ciphertext}]. */
  async function loadCurrent(env) {
    const latest = await db.getLatestVersion();
    if (!latest) return { latest: null, items: [] };
    if (latest.key_fingerprint !== sharedCrypto.fingerprint(env)) {
      throw conflict(`Version ${latest.id} was stored under a different INTEGRATION_SECRET_KEY than the one this app has now.`);
    }
    const rows = await db.getVersionValues(latest.id);
    const items = rows.map((r) => ({
      scope: r.scope, name: r.name, ciphertext: r.ciphertext, value: sharedCrypto.decryptShared(r.ciphertext, env),
    }));
    return { latest, items };
  }

  async function getView() {
    const env = getKeyEnv();
    const state = bootState();
    const latest = await db.getLatestVersion();
    const sameKey = (v) => Boolean(env) && v.key_fingerprint === sharedCrypto.fingerprint(env);
    const values = latest ? (await db.getVersionValues(latest.id)).map((r) => ({
      scope: r.scope,
      name: r.name,
      last4: r.last4 || '',
      inUseHere: state.status === 'loaded' && state.version === Number(latest.id) && r.scope !== 'samsara',
    })) : [];
    const versions = (await db.listVersions(15)).map((v) => ({
      id: Number(v.id),
      createdAt: v.created_at,
      createdBy: v.created_by,
      note: v.note,
      restoredFrom: v.restored_from == null ? null : Number(v.restored_from),
      valueCount: v.value_count,
      sameKey: sameKey(v),
    }));
    return {
      keyConfigured: Boolean(env),
      boot: state,
      latest: latest ? { id: Number(latest.id), createdAt: latest.created_at, createdBy: latest.created_by, sameKey: sameKey(latest) } : null,
      values,
      versions,
    };
  }

  function parseUpload({ target, text }) {
    if (!rules.isTarget(target)) throw badRequest('Choose which app this file is for.');
    const raw = String(text || '');
    if (!raw.trim()) throw badRequest('The file is empty.');
    if (Buffer.byteLength(raw, 'utf8') > MAX_TEXT_BYTES) throw badRequest('The file is too large for a .env file.');
    const parsed = parseEnvText(raw);
    if (parsed.entries.length > MAX_ENTRIES) throw badRequest(`More than ${MAX_ENTRIES} names in one file.`);
    if (!parsed.entries.length) throw badRequest('No NAME=value lines were found in the file.');
    return parsed;
  }

  async function tokenChecksFor(plan) {
    const touched = [...plan.added, ...plan.changed].filter((c) => rules.TOKEN_NAMES.includes(c.name));
    const results = [];
    for (const { scope, name } of touched) {
      const item = plan.items.find((i) => i.scope === scope && i.name === name);
      // eslint-disable-next-line no-await-in-loop
      const r = await tokenCheck(item.value);
      results.push({ name, scope, ok: r.ok === true, bot: r.ok ? r.username : null, error: r.ok ? null : r.error });
    }
    return results;
  }

  /** Everything the page shows before a save. No value anywhere in it. */
  async function preview({ target, text }) {
    const env = requireKey();
    const parsed = parseUpload({ target, text });
    const { latest, items } = await loadCurrent(env);
    const plan = rules.planUpload({ target, entries: parsed.entries, current: items });
    const checks = rules.checkVersion({ items: plan.items, hostEnv: getHostEnv() });
    const tokens = await tokenChecksFor(plan);
    const blocking = [
      ...parsed.problems.map((p) => `Line ${p.line}${p.name ? ` (${p.name})` : ''}: ${p.reason}`),
      ...checks.blocking,
      ...tokens.filter((t) => !t.ok).map((t) => `${t.name}: Telegram refused this token (${t.error})`),
    ];
    return {
      target,
      baseVersion: latest ? Number(latest.id) : null,
      added: plan.added,
      changed: plan.changed,
      removed: plan.removed,
      unchanged: plan.unchanged,
      skipped: plan.skipped,
      duplicates: parsed.duplicates,
      tokens,
      blocking,
      warnings: checks.warnings,
      canSave: blocking.length === 0 && (plan.added.length + plan.changed.length + plan.removed.length) > 0,
      restartsThisApp: [...plan.added, ...plan.changed, ...plan.removed].some((c) => c.scope !== 'samsara'),
      _plan: plan,
    };
  }

  function toRows(planItems, currentItems, env) {
    const old = new Map(currentItems.map((i) => [`${i.scope}\u0000${i.name}`, i]));
    return planItems.map((item) => {
      const prev = old.get(`${item.scope}\u0000${item.name}`);
      const ciphertext = prev && prev.value === item.value ? prev.ciphertext : sharedCrypto.encryptShared(item.value, env);
      return { scope: item.scope, name: item.name, ciphertext, last4: rules.last4(item.value) };
    });
  }

  async function writeVersion({ env, items, currentItems, by, note, restoredFrom = null }) {
    const versionId = await db.insertVersion({
      createdBy: by || null,
      note: note || null,
      keyFingerprint: sharedCrypto.fingerprint(env),
      restoredFrom,
      values: toRows(items, currentItems, env),
    });
    return versionId;
  }

  async function save({ target, text, baseVersion = null, by = null }) {
    const result = await preview({ target, text });
    if (result.baseVersion !== (baseVersion == null ? null : Number(baseVersion))) {
      throw conflict('The secrets changed since this preview. Preview the file again.');
    }
    if (!result.canSave) {
      throw badRequest(result.blocking[0] || 'Nothing to save — the file matches what is stored.', { preview: strip(result) });
    }
    const env = requireKey();
    const { items: currentItems } = await loadCurrent(env);
    const versionId = await writeVersion({
      env, items: result._plan.items, currentItems, by, note: `upload for ${target}`,
    });
    return { versionId, preview: strip(result) };
  }

  async function removeValue({ scope, name, by = null }) {
    const env = requireKey();
    const { latest, items } = await loadCurrent(env);
    if (!latest || !items.some((i) => i.scope === scope && i.name === name)) throw badRequest(`${name} is not stored.`);
    const nextItems = items.filter((i) => !(i.scope === scope && i.name === name));
    const checks = rules.checkVersion({ items: nextItems, hostEnv: getHostEnv() });
    if (checks.blocking.length) throw badRequest(checks.blocking[0]);
    const versionId = await writeVersion({ env, items: nextItems, currentItems: items, by, note: `removed ${name}` });
    return { versionId, restartsThisApp: scope !== 'samsara' };
  }

  async function restore({ versionId, by = null }) {
    const env = requireKey();
    const target = await db.getVersion(versionId);
    if (!target) throw badRequest(`Version ${versionId} does not exist.`);
    if (target.key_fingerprint !== sharedCrypto.fingerprint(env)) {
      throw conflict(`Version ${versionId} was stored under a different INTEGRATION_SECRET_KEY and cannot be opened.`);
    }
    const rows = await db.getVersionValues(versionId);
    const items = rows.map((r) => ({
      scope: r.scope, name: r.name, ciphertext: r.ciphertext, value: sharedCrypto.decryptShared(r.ciphertext, env),
    }));
    const checks = rules.checkVersion({ items, hostEnv: getHostEnv() });
    if (checks.blocking.length) throw badRequest(checks.blocking[0]);
    const newId = await writeVersion({
      env, items, currentItems: items, by, note: `restored version ${versionId}`, restoredFrom: Number(versionId),
    });
    return { versionId: newId, restoredFrom: Number(versionId) };
  }

  return { getView, preview: async (input) => strip(await preview(input)), save, removeValue, restore };
}

/** The preview as it leaves the server: the plan (which holds values) removed. */
function strip(result) {
  const { _plan, ...rest } = result;
  return rest;
}

module.exports = { createSecretsService, ...createSecretsService() };
