/**
 * Finding a provider's official policy pages from its own site. PURE.
 *
 * When a terms URL stops answering, the replacement is almost always linked
 * from the provider's documentation root or its site footer — "Terms",
 * "Privacy", "Pricing", "Deprecations". These helpers turn an HTML page into
 * ranked candidates for one KIND of page, and refuse anything that is not on
 * the provider's own site. A model may later be asked to choose between the
 * candidates this produces; it is never asked to invent one.
 *
 * Deliberately simple string work: an anchor scanner, not a DOM. Terms pages
 * are linked with plain `<a href>` tags in footers and nav bars, and a parser
 * dependency for that would be the first runtime dependency in `services/ai`.
 */

/** What a link to each kind of page tends to say — in its URL or its text. */
const KIND_KEYWORDS = {
  terms: [/terms/i, /\btos\b/i, /legal/i, /conditions/i, /agreement/i, /eula/i],
  privacy: [/privacy/i, /data[-\s]?protection/i, /gdpr/i],
  acceptable_use: [/acceptable[-\s]?use/i, /usage[-\s]?polic/i, /\baup\b/i, /prohibited/i],
  pricing: [/pricing/i, /plans/i, /billing/i, /free[-\s]?tier/i, /rate[-\s]?limits?/i, /quota/i],
  model_policy: [/deprecat/i, /model.*(lifecycle|versions?|availability)/i, /changelog/i, /release[-\s]?notes/i, /\bmodels?\b/i],
  other: [],
};

/** Subdomains that are the same site for our purposes. */
const SITE_PREFIXES = /^(www|docs|console|platform|developers?|api|ai|cloud|help|support|legal|policies|about)\./i;

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

/** The registrable part, roughly: last two labels, ignoring known site prefixes. */
function siteOf(url) {
  const host = hostOf(url);
  if (!host) return null;
  const stripped = host.replace(SITE_PREFIXES, '');
  const labels = stripped.split('.');
  return labels.slice(-2).join('.');
}

function sameSite(a, b) {
  const sa = siteOf(a);
  const sb = siteOf(b);
  return Boolean(sa && sb && sa === sb);
}

/**
 * The address a browser actually asks for: no fragment, no trailing slash.
 *
 * HTTP never sends the `#fragment`, so a source recorded as `/terms#privacy`
 * comes back from fetch as `/terms`. That is the same request, not a redirect —
 * and calling it one would move the source onto the page beside it.
 */
function fetchTargetOf(url) {
  if (!url) return null;
  try {
    const u = new URL(String(url));
    u.hash = '';
    return u.toString().replace(/\/+$/, '');
  } catch {
    return String(url).split('#')[0].replace(/\/+$/, '');
  }
}

function sameFetchTarget(a, b) {
  const ta = fetchTargetOf(a);
  const tb = fetchTargetOf(b);
  return Boolean(ta && tb && ta === tb);
}

/**
 * Every `<a href>` on the page, resolved against `baseUrl`, https only,
 * de-duplicated on the URL without its fragment. Anchor text is kept because a
 * footer link that says "Terms of Service" is worth more than one that says
 * "here".
 */
function extractLinks(html, baseUrl) {
  const out = new Map();
  const re = /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || ''))) !== null) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!raw || raw.startsWith('#') || /^(mailto|javascript|tel):/i.test(raw)) continue;
    let url;
    try { url = new URL(raw, baseUrl); } catch { continue; }
    if (url.protocol !== 'https:') continue;
    url.hash = '';
    const key = url.toString().replace(/\/+$/, '');
    const text = m[4].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!out.has(key)) out.set(key, { url: key, text });
    else if (text && !out.get(key).text) out.get(key).text = text;
  }
  return [...out.values()];
}

/** How much this link looks like a page of `kind`: 0 = not at all. */
function scoreLinkForKind(link, kind) {
  const patterns = KIND_KEYWORDS[kind] || [];
  let score = 0;
  for (const re of patterns) {
    if (re.test(link.url)) score += 3;
    if (re.test(link.text || '')) score += 2;
  }
  // A link whose text is the kind itself ("Terms of Service") beats a passing mention.
  if (kind === 'terms' && /^terms( of (service|use))?$/i.test(link.text || '')) score += 3;
  if (kind === 'privacy' && /^privacy( policy| notice)?$/i.test(link.text || '')) score += 3;
  if (kind === 'pricing' && /^pricing$/i.test(link.text || '')) score += 3;
  // Penalise things that are clearly not policy pages.
  if (/\.(png|jpg|svg|gif|pdf|zip|css|js)$/i.test(link.url)) score = 0;
  if (/(login|signin|sign-in|signup|register|logout|cart|search\?)/i.test(link.url)) score = 0;
  return score;
}

/**
 * Candidates for a `kind` of page, best first, on the provider's own site only.
 *
 * @param {Array<{url, text}>} links   from extractLinks
 * @param {object} options
 * @param {string} options.kind
 * @param {string} options.siteUrl     any URL on the provider's site (docs root, old source)
 * @param {string} [options.exclude]   the URL that just failed — never a candidate
 * @param {number} [options.max=5]
 */
function rankCandidates(links, { kind, siteUrl, exclude = null, max = 5 } = {}) {
  const excluded = exclude ? String(exclude).replace(/\/+$/, '') : null;
  return (links || [])
    .filter((l) => sameSite(l.url, siteUrl))
    .filter((l) => l.url !== excluded)
    .map((l) => ({ ...l, score: scoreLinkForKind(l, kind) }))
    .filter((l) => l.score > 0)
    .sort((a, b) => b.score - a.score || a.url.length - b.url.length)
    .slice(0, max);
}

/**
 * Does a fetched page read like the kind of page we wanted? Cheap and
 * deterministic: long enough to be prose, and it mentions the kind at all.
 */
function looksLikeKind(text, kind) {
  const body = String(text || '');
  if (body.length < 400) return false;
  const patterns = KIND_KEYWORDS[kind] || [];
  return patterns.length === 0 || patterns.some((re) => re.test(body));
}

module.exports = {
  KIND_KEYWORDS, extractLinks, scoreLinkForKind, rankCandidates, looksLikeKind, sameSite, sameFetchTarget, fetchTargetOf, siteOf,
};
