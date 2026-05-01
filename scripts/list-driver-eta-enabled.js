#!/usr/bin/env node
/**
 * One-off: list which active driver groups have dispatch ETA updates enabled.
 * Usage: node scripts/list-driver-eta-enabled.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../database/db');
const config = require('../config/config');

(async () => {
  const rows = await db.getDriverGroupsWithDispatchEtaSettings();
  const etaOn = rows.filter((r) => r.eta_enabled === true).sort((a, b) => a.id - b.id);
  const etaOff = rows.filter((r) => !r.eta_enabled);

  const lines = [];
  lines.push('Generated from DB dispatch_eta_updates.enabled');
  lines.push('');
  lines.push(`GLOBAL: LOAD_INGEST_NOTIFY_EXTRACTION_FAILURE = ${config.loadIngestNotifyExtractionFailure}`);
  lines.push('');
  lines.push(
    `SUMMARY: active driver groups=${rows.length}; ETA enabled=${etaOn.length}; ETA disabled=${etaOff.length}`
  );
  lines.push(
    'NOTE: enabled rows with target_mode=test send ETA text to DISPATCH_ETA_TEST_GROUP_ID, not the driver chat.'
  );
  lines.push('');
  lines.push('columns: id | group_name | telegram_group_id | target_mode | interval_min | last_status');
  etaOn.forEach((r) =>
    lines.push(
      [
        r.id,
        r.group_name,
        r.telegram_group_id,
        r.eta_target_mode,
        r.eta_interval_minutes,
        r.eta_last_status || '',
      ].join('\t')
    )
  );
  lines.push('');
  lines.push('ETA DISABLED:');
  etaOff.forEach((r) => lines.push([r.id, r.group_name, r.telegram_group_id].join('\t')));

  const outPath = path.join(__dirname, '..', 'reports', 'driver-eta-enabled.tsv');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log(lines.join('\n'));
  console.error(`\nAlso wrote: ${outPath}`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
