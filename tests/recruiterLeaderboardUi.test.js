/**
 * Static checks on the recruiter KPI UI sources: the public leaderboard and the
 * admin KPI page must present the new main KPI (2.5h real call duration,
 * calls under 30 seconds don't count) and must no longer mention the retired
 * 50/50 rule. Rendering/build is covered by `npm run build --prefix admin`.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

const publicPage = read('admin/src/pages/RecruitersPublicPage.jsx');
const adminPage = read('admin/src/pages/RecruiterKpiPage.jsx');
const settingsTab = read('admin/src/pages/settings/RingCentralTab.jsx');

test('public leaderboard presents real call duration as the main KPI', () => {
  assert.match(publicPage, /Main KPI/i);
  assert.match(publicPage, /real call duration/i);
  assert.match(publicPage, /valuableTalkSeconds/);
  // The ring gauge is driven by valuable talk time, not raw totals.
  assert.match(publicPage, /TalkRing[\s\S]*?seconds=\{r\.valuableTalkSeconds\}/);
});

test('public leaderboard says short calls do not count', () => {
  assert.match(publicPage, /seconds do not count/i);
});

test('public leaderboard renders date controls and view modes', () => {
  assert.match(publicPage, /Back to Today/);
  assert.match(publicPage, /Yesterday/);
  assert.match(publicPage, /type="date"/);
  assert.match(publicPage, /Apply range/);
  assert.match(publicPage, /Viewing today — live/);
  assert.match(publicPage, /Viewing historical day/);
  assert.match(publicPage, /Viewing date range/);
});

test('public leaderboard ranks by main score then talk progress', () => {
  assert.match(publicPage, /mainScore[\s\S]*?talkPct[\s\S]*?valuableTalkSeconds[\s\S]*?outboundPct[\s\S]*?strongConversations/);
});

test('public leaderboard respects prefers-reduced-motion', () => {
  assert.match(publicPage, /prefers-reduced-motion/);
});

test('old 50/50 wording is gone from the recruiter UIs', () => {
  assert.ok(!publicPage.includes('50/50'), 'public page still mentions 50/50');
  assert.ok(!adminPage.includes('50/50'), 'admin KPI page still mentions 50/50');
  assert.ok(!settingsTab.includes('50/50'), 'settings tab still mentions 50/50');
});

test('admin KPI page uses the talk-time score labels', () => {
  assert.match(adminPage, /Daily Call Duration Score/);
  assert.match(adminPage, /Real Call Duration/);
  assert.match(adminPage, /does NOT count toward talk time/);
});

test('settings tab explains the minimum-duration threshold', () => {
  assert.match(settingsTab, /Minimum call duration counted toward talk time/);
  assert.match(settingsTab, /Calls shorter than this threshold do not count toward real talk time\. Default: 30 seconds\./);
  assert.match(settingsTab, /targetTalkMinutes/);
});
