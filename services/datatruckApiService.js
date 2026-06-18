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
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Datatruck API ${res.status}: ${body.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * Walk a paginated Datatruck collection, returning all result rows.
 * @param {string} path  e.g. 'orders/' or 'drivers/list/'
 * @param {object} [opts]
 * @param {string} [opts.filter] JSON-encoded Datatruck filter array.
 */
async function fetchAllPages(path, { filter } = {}) {
  if (!isConfigured()) {
    throw new Error('Datatruck API is not configured (DATATRUCK_API_TOKEN / DATATRUCK_COMPANY).');
  }
  const rows = [];
  const params = new URLSearchParams({ page: '1', page_size: String(PAGE_SIZE) });
  if (filter) params.set('filter', filter);
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

module.exports = {
  isConfigured,
  fetchAllDrivers,
  fetchOrdersByPickupWindow,
  fetchAllPages,
  PAGE_SIZE,
  REQUEST_SPACING_MS,
};
