/**
 * Driver leads feed — the Leads page's 45-second poll.
 *
 * The server answers 304, with no body and without reading the list, when
 * If-None-Match names the ETag of the list it would send. So the last list and
 * its ETag are remembered per source, every poll asks "still this?", and a 304
 * is answered from memory: a few hundred bytes instead of ~28 KB.
 *
 * The `t` cache-buster stays. Every URL is new, so the browser's own HTTP
 * cache never holds an entry to answer from, and a 304 always arrives here as
 * a 304 instead of as a cached 200.
 *
 * Every call resolves to a NEW array of new objects. The page re-renders on
 * every poll exactly as it did when every poll was a 200, so its "5m ago"
 * column keeps moving, and nothing a caller does to its list changes what is
 * remembered.
 */

import { API_BASE, getHeaders, handleApiError } from './http';

/** source ('' for all) → { etag, leads } from the last 200 that carried an ETag. Owned here. */
const remembered = new Map();

function copyOf(leads) {
  return Array.isArray(leads) ? leads.map((lead) => ({ ...lead })) : leads;
}

function requestLeads(source, etag) {
  const params = new URLSearchParams({ t: String(Date.now()) });
  if (source) params.set('source', source);
  const headers = getHeaders();
  if (etag) headers['If-None-Match'] = etag;
  return fetch(`${API_BASE}/leads?${params.toString()}`, { headers });
}

export async function getLeads(source = '') {
  const key = source || '';
  const kept = remembered.get(key);
  let res = await requestLeads(key, kept?.etag);
  if (res.status === 304) {
    if (kept) return copyOf(kept.leads);
    // Only a request naming an ETag can be answered 304, and this one named
    // none. Should one arrive anyway, ask again unconditionally.
    res = await requestLeads(key, null);
  }
  if (!res.ok) { await handleApiError(res); }
  const leads = await res.json();
  const etag = res.headers.get('ETag');
  if (etag) remembered.set(key, { etag, leads });
  else remembered.delete(key);
  return copyOf(leads);
}
