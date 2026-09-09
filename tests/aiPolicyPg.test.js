/**
 * The policy watcher's data layer, against a real PostgreSQL.
 *
 * The outbox is the part worth testing hardest. Its shape is copied from
 * `home_time_internal_alert_outbox`, and the reason that shape exists is a real
 * incident: a chat id saved with its minus sign dropped, 101 alerts failed,
 * every one spent its full attempt budget, and nothing ever told a human. So
 * the tests here are about the properties that prevent a repeat — attempts
 * counted at CLAIM time so a crash loop stays bounded, and exhaustion COUNTED
 * rather than merely recorded.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();

function load(harness) {
  return harness.loadDataLayer(['aiPolicy', 'aiPolicyFindings', 'aiProviders']);
}

async function harnessWith(t) {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  await harness.query(
    "INSERT INTO ai_providers (provider_key, label, enabled) VALUES ('groq','Groq',TRUE)"
  );
  return harness;
}

async function seedFinding(harness, over = {}) {
  const res = await harness.query(
    `INSERT INTO ai_policy_findings (provider_key, source_url, summary, severity)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [over.providerKey || 'groq', over.url || 'https://x.invalid/terms',
      over.summary || 'Something changed.', over.severity || 'warning']
  );
  return res.rows[0].id;
}

// ─── sources and snapshots ───────────────────────────────────────────────────

test('only sources of ENABLED providers are checked', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { aiPolicy } = load(harness);
  await harness.query(
    "INSERT INTO ai_providers (provider_key, label, enabled) VALUES ('paused','Paused',FALSE)"
  );
  await aiPolicy.addSource({ providerKey: 'groq', url: 'https://a.invalid/terms' });
  await aiPolicy.addSource({ providerKey: 'paused', url: 'https://b.invalid/terms' });

  const toCheck = await aiPolicy.listSourcesToCheck();

  assert.deepEqual(toCheck.map((s) => s.providerKey), ['groq'],
    'a provider nobody is sending data to is not one whose terms are our problem');
  assert.equal((await aiPolicy.listSourcesForAdmin()).length, 2, 'but the admin sees both');
});

test('the admin listing never carries the stored page text', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { aiPolicy } = load(harness);
  const source = await aiPolicy.addSource({ providerKey: 'groq', url: 'https://a.invalid/terms' });
  await aiPolicy.saveSnapshot(source.id, {
    contentHash: 'h1', normalisedText: 'a great deal of third-party prose', httpStatus: 200,
  });

  const [row] = await aiPolicy.listSourcesForAdmin();
  assert.equal('normalisedText' in row, false, 'it is large and no screen needs it');
  assert.equal(row.contentHash, 'h1');
});

test('a 304 refreshes the timestamps and keeps the stored text', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { aiPolicy } = load(harness);
  const source = await aiPolicy.addSource({ providerKey: 'groq', url: 'https://a.invalid/terms' });
  await aiPolicy.saveSnapshot(source.id, {
    contentHash: 'h1', normalisedText: 'the terms', etag: 'W/"v1"', httpStatus: 200,
  });

  await aiPolicy.saveSnapshot(source.id, { httpStatus: 304, etag: 'W/"v1"' });

  const [row] = await aiPolicy.listSourcesToCheck();
  assert.equal(row.normalisedText, 'the terms',
    'a 304 carries no body — it must not blank what we diff against');
  assert.equal(row.contentHash, 'h1');
  assert.equal(row.httpStatus, 304);
});

test('failures count up and a success resets them', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { aiPolicy } = load(harness);
  const source = await aiPolicy.addSource({ providerKey: 'groq', url: 'https://a.invalid/terms' });

  await aiPolicy.saveSnapshot(source.id, { error: 'HTTP 503', httpStatus: 503 });
  await aiPolicy.saveSnapshot(source.id, { error: 'timed out', httpStatus: null });
  let [row] = await aiPolicy.listSourcesToCheck();
  assert.equal(row.consecutiveFailures, 2);
  assert.match(row.lastError, /timed out/);

  await aiPolicy.saveSnapshot(source.id, { contentHash: 'h', normalisedText: 't', httpStatus: 200 });
  [row] = await aiPolicy.listSourcesToCheck();
  assert.equal(row.consecutiveFailures, 0);
  assert.equal(row.lastError, null);
});

test('deleting a provider takes its sources with it', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { aiPolicy } = load(harness);
  await aiPolicy.addSource({ providerKey: 'groq', url: 'https://a.invalid/terms' });

  await harness.query("DELETE FROM ai_providers WHERE provider_key = 'groq'");

  assert.deepEqual(await aiPolicy.listSourcesForAdmin(), []);
});

// ─── findings ────────────────────────────────────────────────────────────────

test('a terms change is an event, so two changes are two findings', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { aiPolicyFindings } = load(harness);
  const common = { providerKey: 'groq', sourceUrl: 'https://x.invalid/terms' };

  await aiPolicyFindings.insertFinding({ ...common, summary: 'Training clause added.' });
  await aiPolicyFindings.insertFinding({ ...common, summary: 'Training clause narrowed.' });

  const findings = await aiPolicyFindings.listFindings();
  assert.equal(findings.length, 2,
    '"they changed it in March" and "again in September" are two things a person needs');
});

test('a suspension cannot be recorded without naming its rule', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  await assert.rejects(
    () => harness.query(
      `INSERT INTO ai_policy_findings (source_url, summary, suspended_provider)
       VALUES ('https://x.invalid', 'AI thought this looked bad', TRUE)`
    ),
    /ai_policy_findings_suspension_names_its_rule/,
    'the schema half of "a model never disables a provider on its own opinion"'
  );
});

test('acknowledging is a one-way door', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { aiPolicyFindings } = load(harness);
  const id = await seedFinding(harness);

  const first = await aiPolicyFindings.acknowledgeFinding(id, 'khomurod');
  assert.equal(first.acknowledgedBy, 'khomurod');
  assert.equal(await aiPolicyFindings.acknowledgeFinding(id, 'someone-else'), null,
    'a second acknowledgement must not overwrite who actually looked');

  const unread = await aiPolicyFindings.listFindings({ unacknowledgedOnly: true });
  assert.deepEqual(unread, []);
});

// ─── the outbox ──────────────────────────────────────────────────────────────

test('one alert per finding, however many times it is enqueued', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { aiPolicyFindings } = load(harness);
  const id = await seedFinding(harness);

  await aiPolicyFindings.enqueueAlert({ findingId: id, chatId: '-100', body: 'first' });
  const second = await aiPolicyFindings.enqueueAlert({ findingId: id, chatId: '-100', body: 'again' });

  assert.equal(second, null);
  const rows = await harness.query('SELECT COUNT(*)::int AS n FROM ai_policy_alert_outbox');
  assert.equal(rows.rows[0].n, 1);
});

test('attempts are spent at CLAIM time, so a crash loop stays bounded',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await harnessWith(t);
    const { aiPolicyFindings } = load(harness);
    const id = await seedFinding(harness);
    await aiPolicyFindings.enqueueAlert({ findingId: id, chatId: '-100', body: 'x' });

    const [claimed] = await aiPolicyFindings.claimDueAlerts(5);

    assert.equal(claimed.attempts, 1,
      'a send that crashes mid-flight has still consumed an attempt');
    // And it is now leased, so a second worker does not take it.
    assert.deepEqual(await aiPolicyFindings.claimDueAlerts(5), []);
  });

test('a failure backs off, and the budget eventually runs out', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { aiPolicyFindings } = load(harness);
  const id = await seedFinding(harness);
  await aiPolicyFindings.enqueueAlert({ findingId: id, chatId: '5052301861', body: 'x' });

  for (let i = 0; i < aiPolicyFindings.MAX_ATTEMPTS; i += 1) {
    const [claimed] = await aiPolicyFindings.claimDueAlerts(5);
    assert.ok(claimed, `attempt ${i + 1} should be claimable`);
    await aiPolicyFindings.markAlertFailed(claimed.id, '400: Bad Request: chat not found');
    // Make it due again so the next claim is not waiting on the backoff.
    await harness.query('UPDATE ai_policy_alert_outbox SET next_attempt_at = NOW()');
  }

  assert.deepEqual(await aiPolicyFindings.claimDueAlerts(5), [],
    'the budget is spent — it must stop rather than retry a dead chat forever');

  const { count, oldestAt } = await aiPolicyFindings.countExhaustedAlerts();
  assert.equal(count, 1, 'and the giving-up is COUNTED — this is the number nobody had last time');
  assert.ok(oldestAt);
});

test('a sent alert is never claimed again', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { aiPolicyFindings } = load(harness);
  const id = await seedFinding(harness);
  await aiPolicyFindings.enqueueAlert({ findingId: id, chatId: '-100', body: 'x' });

  const [claimed] = await aiPolicyFindings.claimDueAlerts(5);
  await aiPolicyFindings.markAlertSent(claimed.id);

  await harness.query('UPDATE ai_policy_alert_outbox SET next_attempt_at = NOW()');
  assert.deepEqual(await aiPolicyFindings.claimDueAlerts(5), []);
  assert.equal((await aiPolicyFindings.countExhaustedAlerts()).count, 0);
});

test('the severity threshold decides who gets told', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { aiPolicyFindings: f } = load(harness);

  assert.equal(f.meetsSeverityThreshold('serious', 'warning'), true);
  assert.equal(f.meetsSeverityThreshold('warning', 'warning'), true);
  assert.equal(f.meetsSeverityThreshold('info', 'warning'), false);
  assert.equal(f.meetsSeverityThreshold('info', 'info'), true);
});

// ─── settings ────────────────────────────────────────────────────────────────

test('the watcher ships off, and nothing is seeded', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { aiPolicy } = load(harness);

  const settings = await aiPolicy.getWatcherSettings();
  assert.equal(settings.enabled, false, 'a deploy must not start fetching by itself');
  assert.equal(settings.autoSuspendEnabled, false, 'and certainly must not start suspending');
  assert.equal(settings.notifyChatId, null);
});

test('a run summary is recorded for the admin to read', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { aiPolicy } = load(harness);

  await aiPolicy.recordRun({ sources: 4, notModified: 3, findings: 1, errors: 0 });

  const settings = await aiPolicy.getWatcherSettings();
  assert.equal(settings.lastRunSummary.findings, 1);
  assert.ok(settings.lastRunAt);
});
