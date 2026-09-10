/**
 * "Is Wenze allowed to use AI for this?" — one question, one answer, cached.
 *
 * `ai_capabilities` has existed since the AI governance work and, until now,
 * NOTHING read it. An administrator could switch a capability off in Settings →
 * AI and every call still went out: the table described an intention that the
 * code never honoured. This is the reader that makes the switch real.
 *
 * TWO RULES WORTH STATING:
 *
 *   A missing row means ENABLED. Capabilities are added by code, and a new one
 *   must not be silently off until someone notices; the seeding pass registers
 *   rows so a person can then turn them off deliberately.
 *
 *   A database problem means ENABLED too. This gate exists to honour a person's
 *   choice, not to become a new way for AI to fail — and every consumer already
 *   degrades safely when a call does not come back.
 */
const aiSettings = require('../../database/aiSettings');

const CACHE_TTL_MS = 30 * 1000;
let cache = { at: 0, byKey: new Map() };

function invalidateCapabilityCache() {
  cache = { at: 0, byKey: new Map() };
}

async function loadCapabilities() {
  const now = Date.now();
  if (cache.byKey.size && now - cache.at < CACHE_TTL_MS) return cache.byKey;
  const rows = await aiSettings.listCapabilities();
  const byKey = new Map();
  for (const row of rows || []) byKey.set(row.capabilityKey, row);
  cache = { at: now, byKey };
  return byKey;
}

/** May this capability use a model right now? */
async function isCapabilityEnabled(capabilityKey) {
  try {
    const byKey = await loadCapabilities();
    const row = byKey.get(capabilityKey);
    if (!row) return true; // not registered yet — see the header
    return row.aiEnabled !== false;
  } catch (err) {
    return true;
  }
}

/** The whole row, for a caller that needs `providerOverride` too. */
async function getCapability(capabilityKey) {
  try {
    return (await loadCapabilities()).get(capabilityKey) || null;
  } catch (err) {
    return null;
  }
}

module.exports = { CACHE_TTL_MS, isCapabilityEnabled, getCapability, invalidateCapabilityCache };
