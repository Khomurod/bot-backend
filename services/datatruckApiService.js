/**
 * Datatruck OpenAPI client (read-only).
 *
 * Docs: https://apidocs.datatruck.io
 * Base URL: https://{company}.datatruck.io/api/v1/openapi/
 * Auth: Authorization: Token <api token>
 * Limits: max 25 items/page, 20 requests/minute.
 *
 * We pace requests conservatively to stay under the documented rate limit.
 */
const config = require('../config/config');

const PAGE_SIZE = 25;
// ~3.1s between requests keeps us under 20 req/min with headroom.
const REQUEST_SPACING_MS = 3100;
const MAX_PAGES = 400; // hard stop so a pagination bug can't loop forever.
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_REQUEST_ATTEMPTS = 4;
const RETRY_BASE_MS = 1_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isConfigured() {
  return Boolean(config.datatruckApiToken && config.datatruckCompany);
}

function baseUrl() {
  return `https://${config.datatruckCompany}.datatruck.io/api/v1/openapi`;
}

function authHeaders() {
  return {
    Authorization: `Token ${config.datatruckApiToken}`,
    'Content-Type': 'application/json',
  };
}

async function fetchJson(url) {
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: authHeaders(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok) return res.json();

      const body = await res.text().catch(() => '');
      const err = new Error(`Datatruck API ${res.status}: ${body.slice(0, 300)}`);
      err.status = res.status;
      lastErr = err;

      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt === MAX_REQUEST_ATTEMPTS) throw err;
      const retryAfterSeconds = Number(res.headers.get('retry-after'));
      const delay = Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
        ? retryAfterSeconds * 1000
        : RETRY_BASE_MS * (2 ** (attempt - 1));
      await sleep(Math.min(delay, 30_000));
    } catch (err) {
      lastErr = err;
      const networkFailure = err?.name === 'AbortError'
        || err?.name === 'TimeoutError'
        || err instanceof TypeError;
      if (!networkFailure || attempt === MAX_REQUEST_ATTEMPTS) throw err;
      await sleep(Math.min(RETRY_BASE_MS * (2 ** (attempt - 1)), 30_000));
    }
  }
  throw lastErr || new Error('Datatruck API request failed.');
}

/**
 * Walk a paginated Datatruck collection, returning all result rows.
 * @param {string} path  e.g. 'orders/' or 'drivers/list/'
 * @param {object} [opts]
 * @param {string} [opts.filter] JSON-encoded Datatruck filter array.
 * @param {string} [opts.ordering] ORM field path; prefix with '-' for descending.
 */
async function fetchAllPages(path, { filter, ordering } = {}) {
  if (!isConfigured()) {
    throw new Error('Datatruck API is not configured (DATATRUCK_API_TOKEN / DATATRUCK_COMPANY).');
  }
  const rows = [];
  const params = new URLSearchParams({ page: '1', page_size: String(PAGE_SIZE) });
  if (filter) params.set('filter', filter);
  if (ordering) params.set('ordering', ordering);
  let url = `${baseUrl()}/${path}?${params.toString()}`;
  let pages = 0;

  while (url && pages < MAX_PAGES) {
    if (pages > 0) await sleep(REQUEST_SPACING_MS);
    const data = await fetchJson(url);
    if (Array.isArray(data?.results)) rows.push(...data.results);
    url = data?.next || null;
    pages += 1;
  }
  return rows;
}

/**
 * Active drivers (the API only returns active drivers). Each row carries
 * account.full_name, driver_type ('company_driver' | 'company_owner'),
 * and hire_date.
 */
async function fetchAllDrivers() {
  return fetchAllPages('drivers/list/');
}

/** Never let a token leak into a log/error string. */
function maskToken(text) {
  const token = config.datatruckApiToken;
  if (!token) return String(text == null ? '' : text);
  return String(text == null ? '' : text).split(token).join('***');
}

/**
 * Fetch a single order by id (read-only). Returns the full order object,
 * including its inline `documents` array. Used for duplicate-document checks
 * before an upload.
 */
async function fetchOrderById(orderId) {
  if (!isConfigured()) {
    throw new Error('Datatruck API is not configured (DATATRUCK_API_TOKEN / DATATRUCK_COMPANY).');
  }
  const id = encodeURIComponent(String(orderId));
  return fetchJson(`${baseUrl()}/orders/${id}/`);
}

/**
 * List the documents already attached to an order (read-only). Each row has
 * { file_type, file_link, uploaded_at, uploaded_by }. Returns [] when the order
 * has none or cannot be read.
 */
async function listOrderDocuments(orderId) {
  const order = await fetchOrderById(orderId).catch(() => null);
  return Array.isArray(order?.documents) ? order.documents : [];
}

// Document-upload wiring. IMPORTANT: the public Datatruck OpenAPI (apidocs.
// datatruck.io) documents reading documents inline on an order but does NOT
// document an upload endpoint. The path + field name below follow the standard
// Django-REST convention and are overridable via env so ops can set the exact,
// Datatruck-confirmed values WITHOUT a code change. Live upload stays gated
// behind DATATRUCK_DOC_UPLOAD_DRY_RUN (default dry-run) precisely because this
// endpoint is unverified against the public docs.
function uploadPathFor(orderId) {
  const tmpl = String(process.env.DATATRUCK_DOC_UPLOAD_PATH || 'orders/{orderId}/documents/');
  return tmpl.replace('{orderId}', encodeURIComponent(String(orderId)));
}

/**
 * Upload one document to an order (multipart/form-data). Low-level: no dry-run,
 * no duplicate check, no DB — the caller (intake pipeline) owns that policy.
 * Never logs the API token.
 *
 * @param {object} p
 * @param {string|number} p.orderId
 * @param {string} p.documentType  bill_of_lading | proof_of_delivery
 * @param {Buffer} p.fileBuffer
 * @param {string} p.filename
 * @param {string} [p.mimeType]
 * @returns {Promise<{documentId:(string|null), fileLink:(string|null), raw:object}>}
 */
async function uploadOrderDocument({ orderId, documentType, fileBuffer, filename, mimeType = 'application/pdf' }) {
  if (!isConfigured()) {
    throw new Error('Datatruck API is not configured (DATATRUCK_API_TOKEN / DATATRUCK_COMPANY).');
  }
  if (!orderId) throw new Error('uploadOrderDocument: orderId is required.');
  if (!Buffer.isBuffer(fileBuffer) || fileBuffer.length === 0) {
    throw new Error('uploadOrderDocument: a non-empty fileBuffer is required.');
  }
  const fileField = String(process.env.DATATRUCK_DOC_UPLOAD_FILE_FIELD || 'file');
  const form = new FormData();
  form.set('file_type', String(documentType));
  form.set(
    fileField,
    new Blob([fileBuffer], { type: mimeType }),
    filename || 'document.pdf'
  );

  const url = `${baseUrl()}/${uploadPathFor(orderId)}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      // Only the auth header — do NOT set Content-Type so fetch adds the
      // multipart boundary itself.
      headers: { Authorization: `Token ${config.datatruckApiToken}` },
      body: form,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`Datatruck upload request failed: ${maskToken(err.message)}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Datatruck upload ${res.status}: ${maskToken(body).slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  const raw = await res.json().catch(() => ({}));
  return {
    documentId: raw?.id != null ? String(raw.id) : null,
    fileLink: raw?.file_link || null,
    raw,
  };
}

/**
 * All orders with pickup_time within [startIso, endIso] (UTC ISO strings),
 * including trip mileage and assigned/team driver names.
 */
async function fetchOrdersByPickupWindow(startIso, endIso) {
  const filter = JSON.stringify([
    {
      column: 'pickup_time',
      value: `${startIso},${endIso}`,
      contains: 'between_datetime',
    },
  ]);
  return fetchAllPages('orders/', { filter });
}

/**
 * All orders with delivery_time within [startIso, endIso] (UTC ISO strings).
 * Each row includes its inline `documents` array (BOL/POD/rate confirmation),
 * from which the delivery service selects BOLs and PODs. Newest deliveries first so
 * a partial/rate-limited scan still surfaces the most recent uploads.
 */
async function fetchOrdersByDeliveryWindow(startIso, endIso) {
  const filter = JSON.stringify([
    {
      column: 'delivery_time',
      value: `${startIso},${endIso}`,
      contains: 'between_datetime',
    },
  ]);
  return fetchAllPages('orders/', { filter, ordering: '-delivery_time' });
}

/**
 * Orders relevant to document uploads. Scanning both pickup and delivery
 * windows catches BOLs uploaded on active loads as well as PODs uploaded at
 * delivery. Datatruck currently ignores filters on documents.uploaded_at, so
 * there is no reliable document-upload timestamp filter at the API level.
 */
function mergeOrdersById(...collections) {
  const byId = new Map();
  for (const order of collections.flat()) {
    const key = order?.id != null ? `id:${order.id}` : `row:${byId.size}`;
    byId.set(key, order);
  }
  return Array.from(byId.values());
}

async function fetchOrdersByDocumentWindow(startIso, endIso) {
  const pickupOrders = await fetchOrdersByPickupWindow(startIso, endIso);
  // Keep separate collection scans within the API's 20 request/minute limit.
  await sleep(REQUEST_SPACING_MS);
  const deliveryOrders = await fetchOrdersByDeliveryWindow(startIso, endIso);
  return mergeOrdersById(pickupOrders, deliveryOrders);
}

/** digits/letters lowercased, collapsed whitespace — for tolerant name matching. */
function normalizeNameForMatch(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Driver-name candidates carried on an order (assigned + team driver). */
function orderDriverCandidates(order) {
  const trip = order?.trip || {};
  return [
    trip.driver__full_name,
    trip.team_driver__full_name,
    order?.assigned_driver,
    order?.driver_name,
  ].filter(Boolean);
}

/** Digits-only unit number with leading zeros stripped (e.g. "771 JAFAR" → "771"). */
function normalizeUnitForMatch(value) {
  const digits = String(value == null ? '' : value).replace(/\D/g, '');
  if (!digits) return null;
  return digits.replace(/^0+(?=\d)/, '');
}

/**
 * Unit/truck-number candidates carried on an order. The live API puts the unit
 * on `trip.truck__unit_number` (e.g. "771 JAFAR"); older/simple shapes may use
 * `assigned_driver_n_truck.truck_unit_number` or a flat field. We return every
 * numeric token so a label like "771 JAFAR" matches unit 771.
 */
function orderUnitCandidates(order) {
  const trip = order?.trip || {};
  const raw = [
    trip.truck__unit_number,
    order?.assigned_driver_n_truck?.truck_unit_number,
    order?.truck_unit_number,
    order?.unit_number,
  ].filter(Boolean);
  const tokens = [];
  for (const label of raw) {
    tokens.push(String(label));
    for (const t of String(label).match(/\d+/g) || []) tokens.push(t);
  }
  return tokens;
}

/**
 * Find the single most relevant in-progress order for a driver by name.
 *
 * Scans orders whose pickup OR delivery falls inside a window around now
 * (default -2d … +5d), matches the assigned/team driver by normalized name,
 * and returns the best candidate: the order whose next un-passed appointment
 * (pickup if still upcoming, else delivery) is soonest. Returns null when no
 * order matches — the location monitor then falls back to AI-parsed load
 * context.
 *
 * Read-only; paced by the shared rate limiter. Datatruck order location field
 * names are not fully documented, so the caller passes the raw order to AI for
 * pickup/delivery extraction rather than relying on fixed field names here.
 */
async function fetchActiveOrderForDriver(driverName, {
  lookbackDays = 2,
  lookaheadDays = 5,
  nowMs = Date.now(),
} = {}) {
  const target = normalizeNameForMatch(driverName);
  if (!target) return null;

  const startIso = new Date(nowMs - lookbackDays * 86_400_000).toISOString();
  const endIso = new Date(nowMs + lookaheadDays * 86_400_000).toISOString();
  const orders = await fetchOrdersByDocumentWindow(startIso, endIso);

  const matched = orders.filter((order) => orderDriverCandidates(order)
    .some((candidate) => {
      const norm = normalizeNameForMatch(candidate);
      return norm && norm === target;
    }));
  if (!matched.length) return null;

  function appointmentMs(order, kind) {
    const iso = kind === 'pickup'
      ? (order?.pickup_time || order?.pickup_appointment_time)
      : (order?.delivery_time || order?.delivery_appointment_time);
    const ms = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(ms) ? ms : null;
  }

  // Rank by the soonest still-relevant appointment: a not-yet-reached pickup
  // wins over delivery; an order entirely in the past sinks to the bottom.
  function sortKey(order) {
    const pu = appointmentMs(order, 'pickup');
    const del = appointmentMs(order, 'delivery');
    if (pu != null && pu >= nowMs) return pu;          // heading to pickup
    if (del != null && del >= nowMs) return del;        // heading to delivery
    return Math.max(pu || 0, del || 0) + 1e15;          // already past → deprioritize
  }

  matched.sort((a, b) => sortKey(a) - sortKey(b));
  return matched[0] || null;
}

/**
 * Find the single most relevant in-progress order for a UNIT/truck number.
 * Mirrors fetchActiveOrderForDriver but matches on the order's unit label
 * (`trip.truck__unit_number`) instead of the driver name — used when the app
 * knows a unit number but not (or not reliably) the driver name. Returns null
 * when no order matches.
 */
async function fetchActiveOrderForUnit(unitNumber, {
  lookbackDays = 2,
  lookaheadDays = 5,
  nowMs = Date.now(),
} = {}) {
  const target = normalizeUnitForMatch(unitNumber);
  if (!target) return null;

  const startIso = new Date(nowMs - lookbackDays * 86_400_000).toISOString();
  const endIso = new Date(nowMs + lookaheadDays * 86_400_000).toISOString();
  const orders = await fetchOrdersByDocumentWindow(startIso, endIso);

  const matched = orders.filter((order) => orderUnitCandidates(order)
    .some((candidate) => normalizeUnitForMatch(candidate) === target));
  if (!matched.length) return null;

  function appointmentMs(order, kind) {
    const iso = kind === 'pickup'
      ? (order?.pickup_time || order?.pickup_appointment_time)
      : (order?.delivery_time || order?.delivery_appointment_time);
    const ms = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(ms) ? ms : null;
  }
  function sortKey(order) {
    const pu = appointmentMs(order, 'pickup');
    const del = appointmentMs(order, 'delivery');
    if (pu != null && pu >= nowMs) return pu;
    if (del != null && del >= nowMs) return del;
    return Math.max(pu || 0, del || 0) + 1e15;
  }
  matched.sort((a, b) => sortKey(a) - sortKey(b));
  return matched[0] || null;
}

module.exports = {
  isConfigured,
  fetchAllDrivers,
  fetchOrderById,
  listOrderDocuments,
  uploadOrderDocument,
  maskToken,
  fetchOrdersByPickupWindow,
  fetchOrdersByDeliveryWindow,
  fetchOrdersByDocumentWindow,
  fetchActiveOrderForDriver,
  fetchActiveOrderForUnit,
  normalizeNameForMatch,
  normalizeUnitForMatch,
  orderDriverCandidates,
  orderUnitCandidates,
  mergeOrdersById,
  fetchAllPages,
  PAGE_SIZE,
  REQUEST_SPACING_MS,
  REQUEST_TIMEOUT_MS,
  MAX_REQUEST_ATTEMPTS,
};
