/**
 * Google Maps directions URL parser — Route Control.
 *
 * Extracts origin / destination / waypoints from a Google Maps *directions*
 * link so we can hand them to the Routes API. Two well-known shapes are handled
 * fully; opaque short links are flagged (and can be expanded via the redirect
 * follower) and anything we cannot reliably read returns a CLEAR error so the
 * caller asks the user to paste origin / destination / waypoints by hand. We
 * never pretend an unparseable link was parsed.
 *
 * The pure parsing (parseDirectionsUrl / classifyPoint) is side-effect free and
 * unit-tested. expandShortLink performs one guarded network redirect follow and
 * is only used at assignment time, never in the monitor loop.
 */

const SHORT_LINK_HOSTS = new Set([
  'goo.gl',
  'maps.app.goo.gl',
  'g.co',
]);

const MAPS_HOSTS = [
  'google.com', 'www.google.com', 'maps.google.com', 'www.google.co',
];

function isGoogleMapsHost(host) {
  const h = String(host || '').toLowerCase();
  if (SHORT_LINK_HOSTS.has(h)) return true;
  if (h === 'goo.gl' || h.endsWith('.goo.gl')) return true;
  return MAPS_HOSTS.some((base) => h === base || h.endsWith(`.${base}`))
    || /(^|\.)google\.[a-z.]+$/.test(h);
}

function isShortLinkHost(host) {
  const h = String(host || '').toLowerCase();
  return SHORT_LINK_HOSTS.has(h) || h.endsWith('.goo.gl');
}

const LATLNG_RE = /^(-?\d{1,3}(?:\.\d+)?),\s*(-?\d{1,3}(?:\.\d+)?)$/;

/**
 * True when a `/maps/dir/` path segment is a Google Maps *place* (origin,
 * waypoint, or destination) rather than a map-state control token.
 *
 * Google appends non-place control segments to the directions path:
 *   - `@40.22,-87.17,6z`  — map center/zoom
 *   - `data=!3m1!4b1…`    — opaque protobuf state blob
 *   - `am=t`, `dir_action=navigate`, `entry=ttu` — `key=value` map flags
 *
 * The last group was previously not filtered, so a link like
 * `/dir/Origin/Destination/@…/am=t/data=…` treated `am=t` as the final place
 * (the destination) and demoted the real destination to a waypoint — which then
 * failed to geocode ("Routes API returned no route"). Real place segments are
 * addresses or "lat,lng" and never take the leading `key=value` form, so
 * rejecting that shape is safe.
 */
function isDirPlaceSegment(seg) {
  if (!seg || seg === 'dir') return false;
  if (seg.startsWith('@')) return false;
  if (/^[a-z0-9_]+=/i.test(seg)) return false;
  return true;
}

/**
 * Classify one point token as coordinates or a place string.
 * @returns {{ raw:string, lat:(number|null), lng:(number|null) }}
 */
function classifyPoint(token) {
  const raw = decodeURIComponent(String(token || '').replace(/\+/g, ' ')).trim();
  const m = LATLNG_RE.exec(raw.replace(/\s+/g, ''));
  if (m) {
    const lat = Number(m[1]);
    const lng = Number(m[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      return { raw, lat, lng };
    }
  }
  return { raw, lat: null, lng: null };
}

function makeError(reason, extra = {}) {
  return {
    parseable: false, isShortLink: false, origin: null, destination: null, waypoints: [], reason, ...extra,
  };
}

/**
 * Parse a Google Maps directions URL.
 * @returns {{
 *   parseable: boolean, isShortLink: boolean, reason?: string,
 *   origin: object|null, destination: object|null, waypoints: object[]
 * }}
 */
function parseDirectionsUrl(input) {
  let url;
  try {
    url = new URL(String(input || '').trim());
  } catch (_) {
    return makeError('That does not look like a URL. Paste a full Google Maps directions link.');
  }
  if (!/^https?:$/.test(url.protocol)) {
    return makeError('Only http(s) Google Maps links are supported.');
  }
  if (!isGoogleMapsHost(url.hostname)) {
    return makeError('That is not a Google Maps link. Paste a link from Google Maps Directions.');
  }

  // Short / opaque links carry no readable origin/destination — must be expanded.
  if (isShortLinkHost(url.hostname)) {
    return {
      parseable: false,
      isShortLink: true,
      origin: null,
      destination: null,
      waypoints: [],
      reason: 'This is a shortened Google Maps link. Expand it (follow the redirect) or paste '
        + 'the full directions link, or enter origin, destination and waypoints manually.',
    };
  }

  // Form 1 — Maps URLs API: /maps/dir/?api=1&origin=..&destination=..&waypoints=A|B
  const params = url.searchParams;
  if (params.get('origin') && params.get('destination')) {
    const waypoints = String(params.get('waypoints') || '')
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(classifyPoint);
    return {
      parseable: true,
      isShortLink: false,
      origin: classifyPoint(params.get('origin')),
      destination: classifyPoint(params.get('destination')),
      waypoints,
    };
  }

  // Form 2 — path form: /maps/dir/Origin/Waypoint/Destination/@lat,lng,z/data=..
  const dirIndex = url.pathname.split('/').findIndex((seg) => seg === 'dir');
  if (dirIndex !== -1) {
    const segments = url.pathname
      .split('/')
      .slice(dirIndex + 1)
      .filter(isDirPlaceSegment);
    const points = segments.map(classifyPoint).filter((p) => p.raw);
    if (points.length >= 2) {
      return {
        parseable: true,
        isShortLink: false,
        origin: points[0],
        destination: points[points.length - 1],
        waypoints: points.slice(1, -1),
      };
    }
    if (points.length === 1) {
      return makeError('This Google Maps link only has a destination. Include a start point, '
        + 'or enter origin, destination and waypoints manually.');
    }
  }

  return makeError('Could not read origin and destination from this Google Maps link. '
    + 'Paste a Directions link, or enter origin, destination and waypoints manually.');
}

/**
 * Follow a shortened Google Maps link's redirect(s) to its full URL, so it can
 * then be parsed. Guarded: only Google hosts, capped redirect count, and a
 * timeout. Uses `fetchImpl` (defaults to global fetch) so it is testable.
 *
 * @returns {Promise<string>} the expanded URL
 * @throws when the link cannot be safely expanded
 */
async function expandShortLink(input, { fetchImpl = fetch, maxRedirects = 5, timeoutMs = 8000 } = {}) {
  let current = String(input || '').trim();
  for (let i = 0; i < maxRedirects; i += 1) {
    let url;
    try {
      url = new URL(current);
    } catch (_) {
      throw new Error('Invalid URL while expanding the short link.');
    }
    if (!isGoogleMapsHost(url.hostname)) {
      throw new Error('Refusing to follow a redirect off Google Maps while expanding the link.');
    }
    // Once it is a full directions link, stop.
    if (!isShortLinkHost(url.hostname)) return current;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(current, { method: 'GET', redirect: 'manual', signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    const location = res.headers?.get ? res.headers.get('location') : null;
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current).toString();
      continue;
    }
    // Some short links resolve via the final response URL rather than a header.
    if (res.url && res.url !== current) {
      current = res.url;
      if (!isShortLinkHost(new URL(current).hostname)) return current;
      continue;
    }
    throw new Error('The shortened Google Maps link did not redirect to a readable directions URL.');
  }
  throw new Error('Too many redirects while expanding the shortened Google Maps link.');
}

module.exports = {
  parseDirectionsUrl,
  classifyPoint,
  expandShortLink,
  isGoogleMapsHost,
  isShortLinkHost,
};
