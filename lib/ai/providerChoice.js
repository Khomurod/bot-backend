'use strict';

/**
 * Which providers may do ONE task, and in what order. Pure.
 *
 * THE OWNER'S DECISION (14 November 2026): reading a candidate's CDL photo is
 * kept to providers the owner chooses — "only Claude", "only the free ones",
 * "Gemini, then Claude". It is built for every task, not for that one: a
 * task maps to an ordered list of provider keys (`ai_capabilities.
 * provider_order`, migration 0107), and the router honours it.
 *
 *   no list (NULL)   the task follows the global order — Settings → AI →
 *                    Order of providers — exactly as every task did before;
 *   a list           only those providers, in that order. Free-only mode
 *                    still refuses a paid provider, a cooled provider is
 *                    still skipped, and a picture still goes only to a model
 *                    that can see (lib/ai/vision.js): the list narrows who is
 *                    asked, it never widens it.
 *
 * A task the catalogue marks `providerChoice: 'required'` reads NO list as an
 * EMPTY one — nobody is asked until a person chooses — because "the global
 * order" would hand a candidate's licence to whichever provider happens to be
 * first.
 */

/** More than this many providers is not a choice. */
const MAX_CHOSEN = 10;
const KEY = /^[a-z0-9][a-z0-9_.-]{0,63}$/i;

/**
 * A list a person sent, cleaned: strings only, trimmed, each key once, known
 * keys only (when `knownKeys` is given).
 * @param {*} input
 * @param {Iterable<string>|null} [knownKeys]
 * @returns {{ok: true, order: string[]} | {ok: false, error: string}}
 */
function normaliseProviderOrder(input, knownKeys = null) {
  if (!Array.isArray(input)) return { ok: false, error: 'The providers must be a list.' };
  if (input.length > MAX_CHOSEN) return { ok: false, error: `At most ${MAX_CHOSEN} providers may be chosen.` };
  const known = knownKeys ? new Set(knownKeys) : null;
  const order = [];
  for (const raw of input) {
    const key = typeof raw === 'string' ? raw.trim() : '';
    if (!KEY.test(key)) return { ok: false, error: 'A provider key is not valid.' };
    if (known && !known.has(key)) return { ok: false, error: `There is no provider "${key}".` };
    if (!order.includes(key)) order.push(key);
  }
  return { ok: true, order };
}

/**
 * The order a task is asked in: `null` (the global order) or a list (only
 * those, in that order — possibly empty: nobody).
 * @param {{providerChoice?: string}|null} meta   the catalogue entry
 * @param {string[]|null|undefined} stored        `ai_capabilities.provider_order`
 */
function effectiveProviderOrder(meta, stored) {
  if (Array.isArray(stored)) return stored.filter((k) => typeof k === 'string' && k);
  return meta?.providerChoice === 'required' ? [] : null;
}

/**
 * The providers of `providers` that are in `order`, in that order. `null`
 * returns them unchanged.
 */
function orderProviders(providers, order) {
  if (!Array.isArray(order)) return providers || [];
  const byKey = new Map((providers || []).map((p) => [p.providerKey, p]));
  return order.map((key) => byKey.get(key)).filter(Boolean);
}

module.exports = {
  MAX_CHOSEN, normaliseProviderOrder, effectiveProviderOrder, orderProviders,
};
