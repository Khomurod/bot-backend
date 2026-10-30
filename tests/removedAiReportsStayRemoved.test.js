'use strict';

/**
 * AI Reports / Insights, and the admin routes no screen called, stay removed.
 *
 * Removed 2026-10-30 after the hidden-functions audit, at the owner's decision
 * (docs/architecture/retired-ai-reports.md). The reports sent a model the
 * whole driver-chat transcript with sender names — against the owner's
 * October 2026 rule that the AI must not read every driver message — and
 * their admin screen had been gone long before. The shared message labelling
 * Driver Retention runs on (`services/aiAnnotationService.js`) stayed.
 *
 * The routes are proven 404 with a valid token in tests/api-surface.test.js;
 * this file holds the modules, imports, capabilities and client functions.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

test('the AI Reports / Insights modules are gone', () => {
  for (const gone of [
    'server/routes/aiReportsRoutes.js', 'services/aiAnalysisService.js',
    'services/aiInsightsService.js', 'services/aiInsights', 'services/insightRenderer.js',
    'database/aiReports.js', 'admin/src/api/aiReports.js',
    'server/routes/facebookConnect/inspectionRoutes.js',
  ]) {
    assert.equal(exists(gone), false, `${gone} must stay removed`);
  }
});

test('nothing mounts, imports or names them', () => {
  const api = read('server/api.js');
  for (const name of ['aiReportsRoutes', 'aiAnalysisService', 'aiInsightsService', 'insightRenderer', 'proxyAuthGuard']) {
    assert.ok(!api.includes(name), `server/api.js must not name ${name}`);
  }
  assert.ok(!read('database/db.js').includes("require('./aiReports')"), 'the db façade does not spread the reports store');
  assert.ok(!read('admin/src/api.js').includes('aiReports'), 'the admin façade does not forward a reports client');
  const catalog = read('lib/ai/capabilityCatalog.js');
  for (const key of ['ai_report_generation', 'ai_insights_narration']) {
    assert.ok(!catalog.includes(key), `no AI capability ${key}`);
  }
});

test('the shared message labelling Driver Retention needs stayed', () => {
  assert.ok(exists('services/aiAnnotationService.js'));
  const annotation = require('../services/aiAnnotationService');
  assert.equal(typeof annotation.annotateChatLogs, 'function');
  assert.ok(read('services/retention/chatAnnotator.js').includes('annotateChatLogs'));
  // Edit by Link kept its two calls; they moved out of the reports client.
  const manager = read('admin/src/api/messageManager.js');
  assert.ok(manager.includes('export async function editTelegramMessage'));
  assert.ok(manager.includes('export async function deleteTelegramMessage'));
});

test('the old driver-group writes have no client left to call them', () => {
  const groups = read('admin/src/api/groups.js');
  for (const fn of ['getGroups', 'setGroupLanguage', 'setGroupBirthday', 'setGroupStatus', 'runGroupStatusAi', 'aiParseDriverProfiles']) {
    assert.ok(!new RegExp(`export async function ${fn}\\(`).test(groups), `${fn} stays removed`);
  }
  // The live list the targeting pickers use is still there.
  assert.ok(groups.includes('export async function getGroupsManage('));
});
