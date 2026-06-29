/**
 * Datatruck BOL/POD document delivery — pure helpers (no network / DB / Telegram).
 *
 * The flow: poll the Datatruck OpenAPI for recently-delivered orders, look at
 * each order's `documents` array, and forward newly-uploaded Bills of Lading
 * and Proofs of Delivery to the matching driver's Telegram group. Everything
 * in this module is side-effect free so it can be unit-tested in isolation.
 */
const { normalizePersonName } = require('./driverGroupTitle');

// The only Datatruck document types that may be delivered to driver groups.
const BOL_FILE_TYPE = 'bill_of_lading';
const POD_FILE_TYPE = 'proof_of_delivery';
const TRACKED_DOCUMENT_LABELS = Object.freeze({
  [BOL_FILE_TYPE]: Object.freeze({ short: 'BOL', long: 'Bill of Lading' }),
  [POD_FILE_TYPE]: Object.freeze({ short: 'POD', long: 'Proof of Delivery' }),
});

function trackedDocumentTypes() {
  return Object.keys(TRACKED_DOCUMENT_LABELS);
}

function isTrackedDocumentType(fileType) {
  return Object.prototype.hasOwnProperty.call(
    TRACKED_DOCUMENT_LABELS,
    String(fileType || '').trim().toLowerCase()
  );
}

function documentLabel(fileType) {
  return TRACKED_DOCUMENT_LABELS[String(fileType || '').trim().toLowerCase()] || null;
}

/**
 * Normalize a unit/truck number for matching: digits only, leading zeros
 * stripped. "008" and "8" both become "8"; non-numeric returns null.
 */
function normalizeUnitNumber(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return null;
  const stripped = digits.replace(/^0+(?=\d)/, '');
  return stripped || null;
}

function parseUploadedAtMs(value) {
  if (!value) return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

/** The order id Datatruck assigns (used for the dedup signature). */
function orderId(order) {
  return order?.id != null ? String(order.id) : null;
}

/** A human-friendly load reference for captions. */
function orderLoadReference(order) {
  return order?.load_id || order?.shipment_id || (order?.id != null ? String(order.id) : null);
}

/** Truck/unit number from the order or its trip. */
function extractOrderUnit(order) {
  return order?.truck__unit_number
    || order?.trip?.truck__unit_number
    || null;
}

/** Primary + team driver names from the order or its trip. */
function extractOrderDriverNames(order) {
  const names = [
    order?.assigned_driver_n_truck?.driver_full_name,
    order?.driver__full_name,
    order?.trip?.driver__full_name,
    order?.team_driver__full_name,
    order?.trip?.team_driver__full_name,
  ];
  const seen = new Set();
  const out = [];
  for (const raw of names) {
    const name = String(raw || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/** Driver/uploader name attached to the Datatruck document, when available. */
function extractDocumentUploaderName(doc) {
  const value = doc?.uploaded_by;
  if (value && typeof value === 'object') {
    return String(
      value.full_name
      || value.driver_full_name
      || value.name
      || [value.first_name, value.last_name].filter(Boolean).join(' ')
      || ''
    ).trim() || null;
  }
  return String(value || '').trim() || null;
}

/**
 * Stable dedup signature for a single document on an order. `seq` disambiguates
 * documents of the same type uploaded at the same instant. The file_link is
 * intentionally NOT part of the signature because Datatruck may hand back a
 * freshly-signed URL on every poll.
 */
function buildDocumentSignature({ orderId: id, fileType, uploadedAt, seq }) {
  return [
    'dt-doc',
    id || 'unknown',
    String(fileType || '').toLowerCase(),
    uploadedAt || 'na',
    Number.isInteger(seq) ? seq : 0,
  ].join('|');
}

/**
 * Extract BOL/POD documents from one order, each annotated with a
 * stable signature and the order's matching context. Returns [] when the order
 * has no tracked documents.
 */
function extractTrackedDocuments(order) {
  const docs = Array.isArray(order?.documents) ? order.documents : [];
  if (!docs.length) return [];
  const id = orderId(order);
  const seqByKey = new Map();
  const out = [];
  for (const doc of docs) {
    const fileType = String(doc?.file_type || '').trim().toLowerCase();
    if (!isTrackedDocumentType(fileType)) continue;
    const fileLink = String(doc?.file_link || '').trim();
    if (!fileLink) continue;
    const uploadedAt = doc?.uploaded_at ? String(doc.uploaded_at) : null;
    const seqKey = `${fileType}|${uploadedAt || ''}`;
    const seq = seqByKey.get(seqKey) || 0;
    seqByKey.set(seqKey, seq + 1);
    out.push({
      signature: buildDocumentSignature({ orderId: id, fileType, uploadedAt, seq }),
      orderId: id,
      loadReference: orderLoadReference(order),
      fileType,
      fileLink,
      uploadedBy: extractDocumentUploaderName(doc),
      uploadedAt,
      uploadedAtMs: parseUploadedAtMs(uploadedAt),
      unitNumber: extractOrderUnit(order),
      driverNames: extractOrderDriverNames(order),
    });
  }
  return out;
}

/**
 * Build a lookup index from canonical driver-group directory rows so a
 * document can be matched to its Telegram group by driver name. Only active,
 * operationally-visible driver groups that
 * the bot can actually message are indexed.
 */
function buildGroupMatchIndex(directoryRows) {
  const byNameKey = new Map();
  for (const row of Array.isArray(directoryRows) ? directoryRows : []) {
    if (row?.group_type !== 'driver') continue;
    if (row.inactive || row.group_active === false) continue;
    if (row.operational_visible === false) continue;
    if (!row.telegram_group_id) continue;

    const key = row.normalized_driver_key;
    if (key) {
      for (const member of String(key).split('|')) {
        const m = member.trim();
        if (m && !byNameKey.has(m)) byNameKey.set(m, row);
      }
    }
  }
  return { byNameKey };
}

/**
 * Match one document's order context to a driver group using the index.
 * The uploader is tried first, then the order's assigned driver names.
 * Truck/unit number is deliberately never considered.
 * @returns {{ group: object, matchedBy: 'name' }|null}
 */
function matchDocumentToGroup(doc, index) {
  if (!index) return null;
  const names = [doc?.uploadedBy, ...(doc?.driverNames || [])];
  const seen = new Set();
  for (const name of names) {
    const key = normalizePersonName(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (key && index.byNameKey.has(key)) {
      return { group: index.byNameKey.get(key), matchedBy: 'name' };
    }
  }
  return null;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatUploadedAt(uploadedAt) {
  const ms = parseUploadedAtMs(uploadedAt);
  if (ms == null) return null;
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

/** HTML caption for the forwarded document message. */
function buildDocumentCaption(doc) {
  const label = documentLabel(doc?.fileType);
  const emoji = doc?.fileType === POD_FILE_TYPE ? '📦' : '📄';
  const title = label ? `${label.long} (${label.short})` : 'Document';
  const lines = [`${emoji} <b>${escapeHtml(title)}</b>`];
  if (doc?.loadReference) lines.push(`Load #${escapeHtml(doc.loadReference)}`);
  if (doc?.driverNames?.length) lines.push(`Driver: ${escapeHtml(doc.driverNames.join(' / '))}`);
  const when = formatUploadedAt(doc?.uploadedAt);
  const meta = [];
  if (doc?.uploadedBy) meta.push(`Uploaded by ${escapeHtml(doc.uploadedBy)}`);
  if (when) meta.push(escapeHtml(when));
  if (meta.length) lines.push(meta.join(' • '));
  return lines.join('\n');
}

/** Best-effort filename for the forwarded document. */
function buildDocumentFilename(doc) {
  const label = documentLabel(doc?.fileType);
  const prefix = label ? label.short : 'DOC';
  const ref = doc?.loadReference ? String(doc.loadReference).replace(/[^A-Za-z0-9_-]+/g, '') : '';
  const base = ref ? `${prefix}_${ref}` : prefix;
  const ext = guessFileExtension(doc?.fileLink);
  return `${base}${ext}`;
}

/**
 * Resolve a document's `file_link` into a fetchable absolute URL. Datatruck
 * returns a relative storage key (e.g. "2026/6/27/<uuid>/<file>.pdf"); we
 * prepend the configured media base. Already-absolute links pass through
 * unchanged so the API can switch to full URLs without a code change.
 */
function resolveDocumentUrl(fileLink, baseUrl) {
  const link = String(fileLink || '').trim();
  if (!link) return null;
  if (/^https?:\/\//i.test(link)) return link;
  const base = String(baseUrl || '').trim();
  if (!base) return link;
  return `${base.replace(/\/+$/, '')}/${link.replace(/^\/+/, '')}`;
}

function guessFileExtension(fileLink) {
  const path = String(fileLink || '').split(/[?#]/)[0];
  const m = path.match(/\.([A-Za-z0-9]{1,5})$/);
  if (m) return `.${m[1].toLowerCase()}`;
  return '.pdf';
}

module.exports = {
  BOL_FILE_TYPE,
  POD_FILE_TYPE,
  TRACKED_DOCUMENT_LABELS,
  trackedDocumentTypes,
  isTrackedDocumentType,
  documentLabel,
  normalizeUnitNumber,
  parseUploadedAtMs,
  orderId,
  orderLoadReference,
  extractOrderUnit,
  extractOrderDriverNames,
  extractDocumentUploaderName,
  buildDocumentSignature,
  extractTrackedDocuments,
  buildGroupMatchIndex,
  matchDocumentToGroup,
  buildDocumentCaption,
  buildDocumentFilename,
  resolveDocumentUrl,
  guessFileExtension,
  formatUploadedAt,
};
