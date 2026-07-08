/**
 * Route Control — Telegram message detection (PURE, unit-tested).
 *
 * Decides whether a driver-group message is an attempt to assign a route, and
 * whether a given Telegram sender is authorized to do so. No DB / network /
 * telegram calls live here — the bot handler gathers the inputs (group row,
 * dispatch-team membership, global-admin flag) and feeds them in.
 *
 * Route Control must react ONLY to real route assignments. In particular:
 *   - Fuel Monitoring department messages (which routinely carry a Google Maps
 *     pin of the fuel stop) must NEVER be treated as a route — a fuel/non-route
 *     guard rejects them up front.
 *   - A plain location pin / place link is NOT a route.
 *   - A bare shortened maps.app.goo.gl link (with no route wording) is NOT a
 *     route — most shared shorts are place pins, not directions.
 *
 * We only act on a message that either:
 *   - contains a Google Maps DIRECTIONS link (real origin + destination or a
 *     `/maps/dir/` path), regardless of wording, OR
 *   - contains a shortened / place / other Google Maps link AND a clear route
 *     keyword phrase (the short link is expanded later to prove it is really a
 *     directions route).
 */
const { isGoogleMapsHost, isShortLinkHost } = require('./googleMapsUrlParser');

// Clear "this is a route" phrases. A bare single word "route" is deliberately
// NOT enough — fuel / status / chit-chat messages say "route" constantly ("on
// your route or not", "en route", "reroute") and were the main source of false
// Route Control replies. Only these strong, intentful phrases count.
const ROUTE_KEYWORDS = [
  'assign route',
  'assigned route',
  'route control',
  'follow this route',
  'take this route',
  'use this route',
  'please use this route',
  'driver route',
  'planned route',
  'new route for driver',
  'route for this driver',
];

// Phrases that mark a message as Fuel Monitoring or another non-route context.
// Any of these → the message is never a Route Control candidate. Kept lowercase
// for case-insensitive substring matching.
const FUEL_OR_NON_ROUTE_PHRASES = [
  'fuel monitoring department',
  'fuel department',
  'please fuel up',
  'fuel level',
  'fuel up',
  'do not use different location',
  '$250 charge',
  '250 charge',
  'travel stop',
  'flying j',
  'loves travel stop',
  "love's travel stop",
  'pilot',
  'gas station',
];

// Matches http(s) URLs; hosts are validated separately via isGoogleMapsHost.
const URL_RE = /https?:\/\/[^\s<>()]+/gi;

/**
 * True when the message is clearly a Fuel Monitoring / non-route message that
 * must never trigger Route Control (even though it often carries a Google Maps
 * pin of the fuel stop). Case-insensitive substring match.
 */
function looksLikeFuelOrNonRoute(text) {
  const lower = String(text || '').toLowerCase();
  return FUEL_OR_NON_ROUTE_PHRASES.some((phrase) => lower.includes(phrase));
}

function hasRouteKeyword(text) {
  const lower = String(text || '').toLowerCase();
  return ROUTE_KEYWORDS.some((k) => lower.includes(k));
}

/** All Google Maps URLs found in the text (trailing punctuation trimmed). */
function extractGoogleMapsLinks(text) {
  const matches = String(text || '').match(URL_RE) || [];
  const links = [];
  for (const rawMatch of matches) {
    const cleaned = rawMatch.replace(/[.,;)\]}>"']+$/, '');
    let url;
    try {
      url = new URL(cleaned);
    } catch (_) {
      continue;
    }
    if (isGoogleMapsHost(url.hostname)) links.push(cleaned);
  }
  return links;
}

/**
 * Classify a Google Maps link.
 * @returns {'directions'|'short'|'place'|'other'}
 */
function classifyMapsLink(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    return 'other';
  }
  if (isShortLinkHost(parsed.hostname)) return 'short';
  const path = parsed.pathname || '';
  const params = parsed.searchParams;
  if (path.includes('/dir/') || (params.get('origin') && params.get('destination'))) {
    return 'directions';
  }
  if (path.includes('/place/') || params.get('q') || /\/@[-0-9.]+,/.test(path)) {
    return 'place';
  }
  return 'other';
}

/**
 * Decide whether a message is a route-assignment attempt.
 *
 * @returns {{ isCandidate:boolean, url?:string, linkKind?:string,
 *             hasKeyword?:boolean, reason?:string }}
 */
function detectRouteAssignment(text) {
  // Guard first: fuel / non-route messages are never route candidates, even if
  // they carry a Google Maps link.
  if (looksLikeFuelOrNonRoute(text)) {
    return { isCandidate: false, reason: 'fuel_or_non_route' };
  }

  const links = extractGoogleMapsLinks(text);
  if (!links.length) return { isCandidate: false };
  const hasKeyword = hasRouteKeyword(text);

  const classified = links.map((url) => ({ url, kind: classifyMapsLink(url) }));

  // A real directions link is always a route (origin + destination present).
  const directions = classified.find((l) => l.kind === 'directions');
  if (directions) {
    return { isCandidate: true, url: directions.url, linkKind: 'directions', hasKeyword };
  }

  // A shortened link is only a candidate WITH a route keyword — expansion later
  // proves whether it is really directions. A bare shared short link is ignored.
  // A place / other link likewise needs a clear route keyword.
  if (hasKeyword) {
    const short = classified.find((l) => l.kind === 'short');
    if (short) return { isCandidate: true, url: short.url, linkKind: 'short', hasKeyword: true };
    return { isCandidate: true, url: classified[0].url, linkKind: classified[0].kind, hasKeyword: true };
  }

  return { isCandidate: false };
}

/**
 * Whether a failed parse should produce the "I could not read this link" reply.
 * We stay silent on a bare shared short link (no route keyword) to avoid noise,
 * but always explain when the user clearly meant to assign a route.
 */
function shouldReplyOnUnparseable({ linkKind, hasKeyword }) {
  if (hasKeyword) return true;
  return linkKind === 'directions';
}

/**
 * Authorization decision for a route assignment.
 * @param {{ isGlobalAdmin:boolean, memberTeamIds:number[], groupTeamIds:number[] }} p
 * @returns {{ authorized:boolean, reason:string, viaTeamId:(number|null) }}
 */
function authorizeRouteAssigner({ isGlobalAdmin = false, memberTeamIds = [], groupTeamIds = [] } = {}) {
  if (isGlobalAdmin) return { authorized: true, reason: 'global_admin', viaTeamId: null };
  if (!memberTeamIds.length) return { authorized: false, reason: 'not_dispatch_member', viaTeamId: null };
  if (!groupTeamIds.length) return { authorized: false, reason: 'group_has_no_team', viaTeamId: null };
  const groupSet = new Set(groupTeamIds.map(Number));
  const shared = memberTeamIds.map(Number).find((id) => groupSet.has(id));
  if (shared != null) return { authorized: true, reason: 'responsible_team', viaTeamId: shared };
  return { authorized: false, reason: 'not_responsible_team', viaTeamId: null };
}

module.exports = {
  ROUTE_KEYWORDS,
  looksLikeFuelOrNonRoute,
  hasRouteKeyword,
  extractGoogleMapsLinks,
  classifyMapsLink,
  detectRouteAssignment,
  shouldReplyOnUnparseable,
  authorizeRouteAssigner,
};
