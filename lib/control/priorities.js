'use strict';

/**
 * "The three things that matter most today", for the morning summary. PURE.
 *
 * The owner asked for this in so many words (2026-10-06). The CANDIDATES and
 * their order come from rules (`lib/control/priority.js`: money, then serious,
 * then warning, then the oldest). AI may only CHOOSE among them and say each in
 * plain words. Every pick must name an item it was given, by number; an
 * invented item, a fourth pick or a duplicate is refused, and with no AI at
 * all the first three by rule are what the summary says.
 */
const { orderForAsking } = require('./priority');

/** How many candidates the model is shown. */
const CANDIDATES = 8;
const PICKS = 3;
const MAX_LINE = 140;

function daysOpen(finding, now) {
  const t = Date.parse(finding?.firstSeenAt || '');
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((new Date(now).getTime() - t) / 86400000));
}

/** The open findings worth considering, most important first. */
function candidatesForToday(openFindings = []) {
  return orderForAsking((openFindings || []).filter((f) => f && f.title)).slice(0, CANDIDATES);
}

function buildPrioritiesPrompt(candidates, now = new Date()) {
  return [
    'You help the owner of a trucking company start the day. Below are the open problems',
    'Wenze (the operations system) found, most important first by its own rules.',
    `Pick the ${PICKS} that matter most TODAY and say each in one short, plain sentence a busy`,
    'owner understands — what it is and why it matters. Use only what is written below.',
    '',
    ...candidates.map((f, i) => {
      const age = daysOpen(f, now);
      return `${i + 1}. [${f.severity || 'info'}] ${f.title}${age != null ? ` (open ${age} day${age === 1 ? '' : 's'})` : ''}`;
    }),
    '',
    'Answer with JSON only: {"picks": [{"item": <number from the list>, "line": "<one sentence>"}]}',
  ].join('\n');
}

/** The router's validator. */
function validatePriorities(candidates) {
  return (_raw, parsed) => {
    const picks = parsed?.picks;
    if (!Array.isArray(picks) || picks.length < 1 || picks.length > PICKS) return { message: 'wrong number of picks' };
    const seen = new Set();
    for (const p of picks) {
      const n = Number(p?.item);
      if (!Number.isInteger(n) || n < 1 || n > candidates.length) return { message: 'pick names no item' };
      if (seen.has(n)) return { message: 'duplicate pick' };
      seen.add(n);
      if (typeof p.line !== 'string' || !p.line.trim() || p.line.length > MAX_LINE * 2) {
        return { message: 'bad line' };
      }
    }
    return true;
  };
}

function clip(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > MAX_LINE ? `${s.slice(0, MAX_LINE - 1).trimEnd()}…` : s;
}

/** Without AI: the first three by rule, by their own titles. */
function fallbackPriorities(candidates) {
  return candidates.slice(0, PICKS).map((f) => clip(f.title));
}

/** With AI: its lines, checked again here, or the fallback. */
function prioritiesFromPicks(candidates, parsed) {
  if (validatePriorities(candidates)(null, parsed) !== true) return fallbackPriorities(candidates);
  return parsed.picks.map((p) => clip(p.line));
}

module.exports = {
  CANDIDATES, PICKS, candidatesForToday, buildPrioritiesPrompt,
  validatePriorities, fallbackPriorities, prioritiesFromPicks,
};
