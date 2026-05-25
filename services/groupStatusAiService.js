/**
 * Twice-daily AI classification of driver group operational status from Telegram titles.
 */
const { DateTime } = require('luxon');
const db = require('../database/db');
const { classifyDriverGroups } = require('./groupStatusAiClassifier');

const TZ = process.env.GROUP_STATUS_AI_TZ || 'America/Chicago';
const DEFAULT_HOURS = [6, 18];
const POLL_MS = 60 * 1000;

function parseHours() {
  const raw = process.env.GROUP_STATUS_AI_HOURS || '6,18';
  const hours = raw.split(',').map((h) => parseInt(h.trim(), 10)).filter((h) => h >= 0 && h <= 23);
  return hours.length ? hours : DEFAULT_HOURS;
}

function isEnabled() {
  return process.env.GROUP_STATUS_AI_ENABLED !== 'false';
}

let serviceTimer = null;
let serviceStopped = false;
let tickRunning = false;

async function runClassificationRun() {
  const groups = await db.getDriverGroupsForStatusAi();
  if (!groups.length) {
    return { updated: 0, skipped: 0, total: 0 };
  }

  const batchSize = parseInt(process.env.GROUP_STATUS_AI_BATCH_SIZE || '25', 10) || 25;
  const classifications = await classifyDriverGroups(groups, batchSize);

  let updated = 0;
  for (const group of groups) {
    const result = classifications.get(group.id);
    if (!result) continue;
    const nextActive = !!result.active;
    if (group.active === nextActive && group.status_source === 'ai') {
      continue;
    }
    await db.updateGroupOperationalStatus(group.id, nextActive, 'ai');
    updated += 1;
  }

  console.log(
    `[GROUP-STATUS-AI] Run complete: ${updated}/${groups.length} groups updated`
  );
  return { updated, skipped: groups.length - updated, total: groups.length };
}

async function checkAndRunScheduled(force = false) {
  if (!isEnabled()) return null;

  const now = DateTime.now().setZone(TZ);
  const isoDate = now.toFormat('yyyy-MM-dd');
  const hours = parseHours();

  for (const hour of hours) {
    if (!force && now.hour !== hour) continue;

    const runKey = `${isoDate}:${String(hour).padStart(2, '0')}`;
    const claimed = await db.claimServiceRun('group_status_ai', runKey);
    if (!claimed && !force) continue;

    if (force) {
      console.log('[GROUP-STATUS-AI] Manual run triggered');
    } else {
      console.log(`[GROUP-STATUS-AI] Starting scheduled run ${runKey}`);
    }

    return runClassificationRun();
  }

  return null;
}

async function tick() {
  if (tickRunning) return;
  tickRunning = true;
  try {
    await checkAndRunScheduled(false);
  } catch (err) {
    console.error('[GROUP-STATUS-AI] Tick error:', err.message);
  } finally {
    tickRunning = false;
  }
}

function startGroupStatusAiService() {
  if (!isEnabled()) {
    console.log('[GROUP-STATUS-AI] Service disabled (GROUP_STATUS_AI_ENABLED=false)');
    return;
  }
  const hours = parseHours();
  console.log(
    `[GROUP-STATUS-AI] Service started — runs at ${hours.map((h) => `${h}:00`).join(', ')} ${TZ}`
  );
  serviceStopped = false;
  tick();
  serviceTimer = setInterval(() => {
    if (!serviceStopped) tick();
  }, POLL_MS);
}

function stopGroupStatusAiService() {
  serviceStopped = true;
  if (serviceTimer) {
    clearInterval(serviceTimer);
    serviceTimer = null;
  }
}

module.exports = {
  startGroupStatusAiService,
  stopGroupStatusAiService,
  runClassificationRun,
  checkAndRunScheduled,
  isEnabled,
};
