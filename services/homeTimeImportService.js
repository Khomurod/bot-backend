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
const { prepareImagePartsForAi } = require('./aiImagePrep');
const groupsDb = require('../database/groups');
const homeTimeStatus = require('./homeTimeService');

const MAX_INLINE_BYTES = 6 * 1024 * 1024; // per image, keep prompts sane

/**
 * Run Gemini vision over the uploaded images and return raw driver rows:
 *   [{ name, status:'road'|'home'|null, since_date, history:[{from,to}], notes }]
 */
async function extractFromImages(files) {
  const images = await prepareImagePartsForAi(
    (Array.isArray(files) ? files : [])
      .filter((f) => f?.buffer && f?.mimetype?.startsWith('image/') && f.buffer.length <= MAX_INLINE_BYTES)
  );

  if (!images.length) {
    const err = new Error('No readable image files were uploaded.');
    err.status = 400;
    throw err;
  }

  // Company time, like every other home-time prompt (see homeTimeIntentService
  // and homeTimeRequestConstants). Without the zone this is the process default
  // — UTC on Render — so an evening upload told the model it was already
  // tomorrow, and "the most recent PAST occurrence" could resolve a day ahead.
  const today = DateTime.now().setZone('America/Chicago').toISODate();
  const prompt = `You are reading screenshot(s) of a spreadsheet that tracks truck drivers' home time. `
    + `Each data row is one driver. Read EVERY data row across ALL the attached images.\n`
    + `Today's date is ${today} (America/Chicago). Resolve any date written without a year to the most recent PAST `
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
  const report = {
    statusesUpdated: 0, statusFailed: 0, historyAdded: 0, historySkipped: 0, skippedRows: 0,
  };

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
    //
    // Through `applyStateTransition`, not a bare `upsertDriverHomeStatus`. The
    // direct write moved the flip-flop and nothing else, so an import that put a
    // driver back on the road left their home-time cycle open forever, and one
    // that brought a driver home recorded no cycle at all — one of the two paths
    // behind 74 open cycles out of 79 in production. It also silently reset the
    // extra-week bonus watermark on every import, because
    // `upsertDriverHomeStatus` defaults `roadBonusWeeksNotified` to 0 and this
    // call never passed one.
    //
    // `announce: false`: importing a screenshot of last quarter is bookkeeping,
    // not news. Nothing is posted, and a bonus recorded this way is marked as
    // already-posted so the notifier does not fire months of stale summaries
    // into a live group.
    const status = normalizeStatus(row.status);
    const since = isoDateOrNull(row.since_date);
    if (status && since) {
      const sinceIso = DateTime.fromISO(`${since}T00:00:00`, { zone: 'utc' }).toISO();
      const group = await groupsDb.getGroupByIdAnyType(groupId);
      const applied = group
        ? await homeTimeStatus.applyStateTransition(null, group, {
          newState: status,
          eventAt: sinceIso,
          statusText: 'Imported from screenshot',
          announce: false,
          // A corrected screenshot often carries the SAME state and a DIFFERENT
          // date ("still on the road, but left on the 3rd"). Without this the
          // same-state branch touches only the last-status fields and the road
          // clock keeps its wrong start — silently, while the import reports
          // the row as updated.
          resyncSince: true,
        })
        : null;
      if (applied && applied.disabled) {
        // Tracking is off entirely: record the state so the import is not a
        // silent no-op. With the feature off there are no cycles to keep
        // consistent, so a plain write leaks nothing.
        await ht.upsertDriverHomeStatus({
          groupId,
          telegramGroupId,
          state: status,
          stateSince: sinceIso,
          lastStatusText: 'Imported from screenshot',
          lastStatusAt: sinceIso,
        });
        report.statusesUpdated += 1;
      } else if (!applied) {
        // The group is gone, or the transition failed. Do NOT write the state
        // anyway — that is how the flip-flop moves without its cycle.
        report.statusFailed += 1;
      } else {
        report.statusesUpdated += 1;
      }
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
