/**
 * Home-Time screenshot import.
 *
 * The admin uploads one or more screenshots of a spreadsheet that lists drivers,
 * whether they are On the Road or At Home, the date they left/returned, and a
 * history of past home-time periods. Gemini vision reads every row, we match each
 * driver to a Telegram driver group, then set their current home/road state (with
 * the correct start date) and register their historical home times so the policy
 * tracker is seeded with real data.
 *
 * Two steps: extractAndMatch() (parse + match for the admin to review) and
 * applyRows() (write the reviewed rows). Pure-ish — all Telegram-free.
 */
const { DateTime } = require('luxon');
const db = require('../database/db');
const ht = require('../database/homeTime');
const { callGeminiJson } = require('./geminiClient');
const { isoDateOrNull, normalizeStatus, matchCandidate } = require('./homeTimeImportHelpers');

const MAX_INLINE_BYTES = 6 * 1024 * 1024; // per image, keep prompts sane

/**
 * Run Gemini vision over the uploaded images and return raw driver rows:
 *   [{ name, status:'road'|'home'|null, since_date, history:[{from,to}], notes }]
 */
async function extractFromImages(files) {
  const images = (Array.isArray(files) ? files : [])
    .filter((f) => f?.buffer && f?.mimetype?.startsWith('image/') && f.buffer.length <= MAX_INLINE_BYTES)
    .map((f) => ({ inline_data: { mime_type: f.mimetype, data: f.buffer.toString('base64') } }));

  if (!images.length) {
    const err = new Error('No readable image files were uploaded.');
    err.status = 400;
    throw err;
  }

  const today = DateTime.now().toISODate();
  const prompt = `You are reading screenshot(s) of a spreadsheet that tracks truck drivers' home time. `
    + `Each data row is one driver. Read EVERY data row across ALL the attached images.\n`
    + `Today's date is ${today}. Resolve any date written without a year to the most recent PAST `
    + `occurrence (never a future year).\n\n`
    + `For each driver return:\n`
    + `- name: the driver's full name (the first column), exactly as written.\n`
    + `- status: "road" if the status is "On the Road", "home" if "At Home", else null.\n`
    + `- since_date: the "Date Left / Returned" value as ISO YYYY-MM-DD (when they left for the road, `
    + `or returned home). null if blank.\n`
    + `- history: array of past home-time periods from the "Home Time History" column. `
    + `Convert ranges like "20 - 26 May (6 days)" to {"from":"2026-05-20","to":"2026-05-26"}. Empty array if none.\n`
    + `- notes: the Notes column text, or "".\n\n`
    + `Ignore section header rows (e.g. "Home Time Requests", "At Home", "On the Road") and the column `
    + `header row. Respond with JSON only: `
    + `{"drivers":[{"name":"","status":"road|home|null","since_date":"YYYY-MM-DD|null","history":[{"from":"","to":""}],"notes":""}]}`;

  const { parsed } = await callGeminiJson({
    userText: prompt,
    extraParts: images,
    maxOutputTokens: 4000,
    validateParsed: (p) => Array.isArray(p?.drivers),
  });

  return (parsed.drivers || [])
    .map((d) => ({
      name: String(d.name || '').trim(),
      status: normalizeStatus(d.status),
      since_date: isoDateOrNull(d.since_date),
      history: (Array.isArray(d.history) ? d.history : [])
        .map((h) => ({ from: isoDateOrNull(h.from), to: isoDateOrNull(h.to) }))
        .filter((h) => h.from && h.to && h.to >= h.from),
      notes: String(d.notes || '').trim(),
    }))
    .filter((d) => d.name);
}

/** Candidate driver groups for name matching. */
async function loadCandidates() {
  const profiles = await db.listDriverProfiles({ includeInactive: true });
  return profiles.map((p) => ({
    group_id: p.group_id,
    telegram_group_id: p.telegram_group_id,
    full_name: p.full_name || '',
    group_name: p.group_name || '',
    unit_number: p.unit_number || null,
    driver_label: p.full_name || p.group_name || `Group ${p.group_id}`,
  }));
}

/**
 * Parse the screenshots and attach a matched group to each row so the admin can
 * review before applying. Returns rows shaped for the apply step.
 */
async function extractAndMatch(files) {
  const rows = await extractFromImages(files);
  const candidates = await loadCandidates();
  return rows.map((row) => {
    const match = matchCandidate(row.name, candidates);
    return {
      name: row.name,
      status: row.status,
      since_date: row.since_date,
      history: row.history,
      notes: row.notes,
      matched: Boolean(match),
      group_id: match?.group_id || null,
      telegram_group_id: match?.telegram_group_id || null,
      driver_label: match?.driver_label || null,
      unit_number: match?.unit_number || null,
    };
  });
}

/**
 * Apply reviewed rows: set each matched driver's current state (+ start date)
 * and register their historical home times (deduped). Returns a summary.
 */
async function applyRows(rows) {
  const report = { statusesUpdated: 0, historyAdded: 0, historySkipped: 0, skippedRows: 0 };

  for (const row of Array.isArray(rows) ? rows : []) {
    const groupId = Number(row?.group_id);
    if (!Number.isInteger(groupId) || groupId <= 0) {
      report.skippedRows += 1;
      continue;
    }
    const telegramGroupId = row.telegram_group_id || null;
    const driverName = row.driver_label || row.name || null;
    const unitNumber = row.unit_number || null;

    // Current state.
    const status = normalizeStatus(row.status);
    const since = isoDateOrNull(row.since_date);
    if (status && since) {
      const sinceIso = DateTime.fromISO(`${since}T00:00:00`, { zone: 'utc' }).toISO();
      await ht.upsertDriverHomeStatus({
        groupId,
        telegramGroupId,
        state: status,
        stateSince: sinceIso,
        lastStatusText: 'Imported from screenshot',
        lastStatusAt: sinceIso,
      });
      report.statusesUpdated += 1;
    }

    // Historical home times → approved requests (deduped by window).
    for (const h of Array.isArray(row.history) ? row.history : []) {
      const from = isoDateOrNull(h.from);
      const to = isoDateOrNull(h.to);
      if (!from || !to) continue;
      const existing = await ht.findHomeTimeRequestByWindow(groupId, from, to);
      if (existing) { report.historySkipped += 1; continue; }
      const created = await ht.insertHomeTimeRequest({
        groupId,
        telegramGroupId,
        driverName,
        unitNumber,
        homeFrom: from,
        homeTo: to,
        status: 'pending',
        source: 'manual',
        requestedByUsername: 'screenshot-import',
      });
      await ht.decideHomeTimeRequest(created.id, { status: 'approved', username: 'screenshot-import' });
      report.historyAdded += 1;
    }
  }

  return report;
}

module.exports = {
  extractFromImages,
  extractAndMatch,
  applyRows,
  matchCandidate,
  normalizeStatus,
  isoDateOrNull,
};
