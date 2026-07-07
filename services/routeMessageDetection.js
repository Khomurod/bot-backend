/**
 * Route Control — Telegram message detection (PURE, unit-tested).
 *
 * Decides whether a driver-group message is an attempt to assign a route, and
 * whether a given Telegram sender is authorized to do so. No DB / network /
 * telegram calls live here — the bot handler gathers the inputs (group row,
 * dispatch-team membership, global-admin flag) and feeds them in.
 *
 * A plain Google Maps *location pin* is deliberately NOT treated as a route.
 * We only act on a message that either:
 *   - contains a Google Maps DIRECTIONS link (origin + destination), or a
 *     shortened maps.app.goo.gl link (which is expanded later), OR
 *   - contains any Google Maps link AND a clear route keyword.
 */
const { isGoogleMapsHost, isShortLinkHost } = require('./googleMapsUrlParser');

// Clear "this is a route" phrases. `route` alone counts but only on a word
// boundary so words like "en route to" still match while "reroute"/"router" do
// not accidentally trigger on unrelated text.
const ROUTE_KEYWORDS = [
  'assigned route',
  'take this route',
  'follow this route',
  'driver route',
  'please use this route',
  'use this route',
  'route control',
  'planned route',
];

const SINGLE_WORD_ROUTE_RE = /\broute\b/i;
// Matches http(s) URLs; hosts are validated separately via isGoogleMapsHost.
const URL_RE = /https?:\/\/[^\s<>()]+/gi;

function hasRouteKeyword(text) {
  const lower = String(text || '').toLowerCase();
  if (ROUTE_KEYWORDS.some((k) => lower.includes(k))) return true;
  return SINGLE_WORD_ROUTE_RE.test(lower);
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
 * @returns {{ isCandidate:boolean, url?:string, linkKind?:string, hasKeyword?:boolean }}
 */
function detectRouteAssignment(text) {
  const links = extractGoogleMapsLinks(text);
  if (!links.length) return { isCandidate: false };
  const hasKeyword = hasRouteKeyword(text);

  const classified = links.map((url) => ({ url, kind: classifyMapsLink(url) }));
  // Prefer an explicit directions link, then a shortened link, then (only when
  // a route keyword is present) a place/other link.
  const directions = classified.find((l) => l.kind === 'directions');
  if (directions) return { isCandidate: true, url: directions.url, linkKind: 'directions', hasKeyword };
  const short = classified.find((l) => l.kind === 'short');
  if (short) return { isCandidate: true, url: short.url, linkKind: 'short', hasKeyword };
  if (hasKeyword) {
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
  hasRouteKeyword,
  extractGoogleMapsLinks,
  classifyMapsLink,
  detectRouteAssignment,
  shouldReplyOnUnparseable,
  authorizeRouteAssigner,
};
