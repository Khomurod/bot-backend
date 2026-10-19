/**
 * A Facebook event that keeps failing must STOP, and a retried lead must not
 * repeat what already reached the outside world.
 *
 * Production, October 2026: a test lead from May had been retried every fifteen
 * minutes for five months (9,041 attempts), and seven September leads were
 * retried 94–238 times — the whole event re-ran from the top each time, so
 * every attempt that got past the fetch posted the lead to the group again.
 *
 * Pinned here:
 *   - the fifth failure abandons the event and tells the leads group ONCE;
 *   - an abandoned event is never claimed again;
 *   - startup abandons events that already spent their budget, quietly;
 *   - a retry after the Telegram post does not post again, and reuses the
 *     Bitrix record instead of creating a second one;
 *   - a person's Retry gives the event a fresh budget;
 *   - the retry ladder spreads five attempts over more than an hour.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-leads-bot-token';
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.MANAGEMENT_GROUP_ID ||= '-1001234567890';
process.env.JWT_SECRET ||= 'test-jwt-secret';
process.env.FACEBOOK_WEBHOOK_SWEEP_MS = String(60 * 60 * 1000);

let rows = [];
let nextId = 1;
const sentMessages = [];
const bitrixLeads = [];
const leadRows = new Map();
let graphShouldFail = false;
let autoMessageFailures = 0;

function reset() {
  rows = [];
  nextId = 1;
  sentMessages.length = 0;
  bitrixLeads.length = 0;
  leadRows.clear();
  graphShouldFail = false;
  autoMessageFailures = 0;
}

const fakeDb = {
  insertFacebookWebhookEvents: async (events) => events.map((event) => {
    const row = {
      id: nextId++,
      event_key: event.eventKey,
      page_id: String(event.pageId),
      event_type: event.eventType,
      payload: event.payload,
      status: 'pending',
      attempt_count: 0,
      next_retry_at: new Date(Date.now() - 1),
      last_error: null,
      telegram_posted_at: null,
    };
    rows.push(row);
    return row;
  }),
  claimPendingFacebookWebhookEvents: async (limit = 10) => {
    const due = rows
      .filter((r) => ['pending', 'failed'].includes(r.status) && new Date(r.next_retry_at) <= Date.now())
      .slice(0, limit);
    for (const row of due) {
      row.status = 'processing';
      row.attempt_count += 1;
    }
    return due.map((row) => ({ ...row }));
  },
  completeFacebookWebhookEvent: async (id) => {
    const row = rows.find((r) => r.id === id);
    if (row) row.status = 'completed';
    return row || null;
  },
  failFacebookWebhookEvent: async (id, message, nextRetryAt) => {
    const row = rows.find((r) => r.id === id);
    if (row) Object.assign(row, { status: 'failed', last_error: message, next_retry_at: nextRetryAt });
    return row || null;
  },
  abandonFacebookWebhookEvent: async (id, message) => {
    const row = rows.find((r) => r.id === id);
    if (row) Object.assign(row, { status: 'abandoned', last_error: message });
    return row ? { id } : null;
  },
  markFacebookWebhookEventTelegramPosted: async (id) => {
    const row = rows.find((r) => r.id === id);
    if (row && !row.telegram_posted_at) row.telegram_posted_at = new Date();
  },
  resetFacebookWebhookEventByIdentifier: async (identifier) => {
    const row = rows.find((r) => r.event_key === identifier || String(r.id) === String(identifier));
    if (!row) return null;
    Object.assign(row, {
      status: 'pending', attempt_count: 0, next_retry_at: new Date(Date.now() - 1), last_error: null,
    });
    return { ...row };
  },
  query: async (sql, params = []) => {
    if (/MIN\(next_retry_at\)/.test(sql)) {
      const waiting = rows
        .filter((r) => ['pending', 'failed'].includes(r.status))
        .map((r) => new Date(r.next_retry_at).getTime());
      return { rows: [{ next_due_at: waiting.length ? new Date(Math.min(...waiting)) : null }] };
    }
    if (/SET status = 'pending'/.test(sql)) {
      for (const row of rows.filter((r) => r.status === 'processing')) {
        row.status = 'pending';
        row.attempt_count = Math.min(row.attempt_count, 4);
      }
    }
    if (/SET status = 'abandoned'/.test(sql)) {
      for (const row of rows) {
        if (['pending', 'failed'].includes(row.status) && row.attempt_count >= params[0]) {
          row.status = 'abandoned';
        }
      }
    }
    return { rows: [] };
  },
  getFacebookPageConnectionByPageId: async (pageId) => ({
    page_id: pageId,
    page_name: 'Wenze Recruiting',
    telegram_group_id: '-1005555555555',
    access_token_encrypted: 'encrypted-token',
  }),
  createLeadIfNew: async ({ externalId }) => {
    if (leadRows.has(externalId)) return null;
    const lead = { id: leadRows.size + 1, external_id: externalId, bitrix_id: null, sms_from_number: null };
    leadRows.set(externalId, lead);
    return { id: lead.id };
  },
  getLeadBySourceExternalId: async (source, externalId) => leadRows.get(externalId) || null,
  updateLeadBitrixResult: async (id, { bitrixId }) => {
    for (const lead of leadRows.values()) if (lead.id === id) lead.bitrix_id = bitrixId;
  },
  updateLeadSmsSender: async () => ({}),
};

require.cache[require.resolve('../database/db')] = { exports: fakeDb };
// The run ledger is an observation; this suite is about the queue.
require.cache[require.resolve('../services/operations/runLedger')] = {
  exports: {
    noteHeartbeat: async () => {},
    withRunRecord: async (key, fn) => fn(),
    statusFromSummary: () => 'ok',
    ranToCompletion: () => true,
  },
};
require.cache[require.resolve('../lib/security/facebookCrypto')] = {
  exports: { decryptText: () => 'page-access-token' },
};
require.cache[require.resolve('../services/facebookGraphService')] = {
  exports: {
    fetchLeadById: async ({ leadgenId }) => {
      if (graphShouldFail) throw new Error('Lead not found');
      return {
        id: leadgenId,
        field_data: [
          { name: 'full_name', values: ['Alex Driver'] },
          { name: 'phone_number', values: ['+15551230000'] },
        ],
      };
    },
    fetchSenderProfile: async () => ({}),
  },
};
require.cache[require.resolve('../services/telegramHtml')] = {
  exports: { safeSend: async (fn) => fn() },
};
require.cache[require.resolve('../services/ringCentralSmsService')] = {
  exports: {
    sendSms: async () => ({ ok: true, messageId: 'rc-1' }),
    sendSmsAsRecruiter: async () => ({ ok: false, reason: 'recruiter_not_configured' }),
  },
};
require.cache[require.resolve('../database/ringcentral')] = {
  exports: {
    hasMappedSmsSenders: async () => false,
    getRecruiterByBitrixUserId: async () => null,
    recruiterCanSendSms: () => false,
  },
};
require.cache[require.resolve('../services/facebookLeadAutoMessageService')] = {
  exports: {
    // The step AFTER the Telegram post and the Bitrix record. Failing here is
    // what used to re-post a lead on every retry.
    loadAutoMessageConfig: async () => {
      if (autoMessageFailures > 0) {
        autoMessageFailures -= 1;
        throw new Error('database blip');
      }
      return { settings: { id: 1, is_enabled: false }, rules: [] };
    },
    resolveAutoSmsForLead: async () => ({ isEnabled: false }),
    LEGACY_HARDCODED_TEMPLATE: 'legacy',
  },
};
require.cache[require.resolve('../services/bitrix24Service')] = {
  exports: {
    createCrmRecordFromLead: async ({ leadgenId }) => {
      bitrixLeads.push(leadgenId);
      return { ok: true, bitrixId: `B-${bitrixLeads.length}`, entity: 'lead' };
    },
    getBitrixMapperConfig: async () => ({ entity: 'lead' }),
    waitForCrmAssignee: async () => ({ assignedById: null, accepted: false, attempts: 1 }),
  },
};
require.cache[require.resolve('../services/facebookLeadSmsMirrorService')] = {
  exports: { sendAutoMessageSentNotice: async () => ({}) },
};

const {
  configureFacebookLeadTelegram,
  startFacebookWebhookWorker,
  stopFacebookWebhookWorker,
  enqueueVerifiedFacebookPayload,
  retryFacebookWebhookEvent,
  getRetryDelayMs,
  buildAbandonedNotice,
  MAX_EVENT_ATTEMPTS,
} = require('../services/facebookWebhookService');

configureFacebookLeadTelegram({
  sendMessage: async (chatId, text) => {
    sentMessages.push({ chatId, text });
    return { message_id: sentMessages.length };
  },
});

function leadgenPayload(leadgenId) {
  return {
    object: 'page',
    entry: [{ id: '9001', changes: [{ field: 'leadgen', value: { leadgen_id: leadgenId, page_id: '9001' } }] }],
  };
}

async function waitFor(predicate, { timeoutMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return true;
}

test('five failures abandon the event and tell the leads group once', async () => {
  reset();
  graphShouldFail = true;
  await startFacebookWebhookWorker();

  await enqueueVerifiedFacebookPayload(leadgenPayload('lead-gone'));
  assert.ok(await waitFor(() => rows[0].status === 'failed'));

  // Drive the remaining attempts: make the row due, and let an unrelated event
  // arriving trigger the next drain — no timer fires in this suite.
  for (let attempt = 2; attempt <= MAX_EVENT_ATTEMPTS; attempt += 1) {
    rows[0].next_retry_at = new Date(Date.now() - 1);
    // eslint-disable-next-line no-await-in-loop
    await enqueueVerifiedFacebookPayload(leadgenPayload(`nudge-${attempt}`));
    // eslint-disable-next-line no-await-in-loop
    assert.ok(await waitFor(() => rows[0].attempt_count === attempt
      && rows[0].status !== 'processing'));
  }

  assert.equal(rows[0].status, 'abandoned');
  assert.match(rows[0].last_error, /Lead not found/);
  const notices = sentMessages.filter((m) => /could not be processed/.test(m.text));
  assert.equal(notices.length, 1, 'one notice, not one per attempt');
  assert.equal(notices[0].chatId, '-1005555555555');
  assert.match(notices[0].text, /lead-gone/);
  assert.match(notices[0].text, /Retry/);

  // Never claimed again.
  const attempts = rows[0].attempt_count;
  await enqueueVerifiedFacebookPayload(leadgenPayload('nudge-final'));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(rows[0].attempt_count, attempts);
  assert.equal(rows[0].status, 'abandoned');

  await stopFacebookWebhookWorker();
});

test('startup abandons events that already spent their budget, without a notice', async () => {
  reset();
  rows.push({
    id: nextId++,
    event_key: 'leadgen:444444444444:test-lead',
    page_id: '444444444444',
    event_type: 'leadgen',
    payload: { leadgenId: 'test-lead' },
    status: 'failed',
    attempt_count: 9041,
    next_retry_at: new Date(Date.now() - 1),
    last_error: 'No active Facebook Page connection found for page 444444444444',
    telegram_posted_at: null,
  });

  await startFacebookWebhookWorker();
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(rows[0].status, 'abandoned');
  assert.equal(rows[0].attempt_count, 9041, 'not tried again');
  assert.equal(sentMessages.length, 0, 'old events are retired quietly');

  await stopFacebookWebhookWorker();
});

test('a retry after the Telegram post neither posts again nor creates a second Bitrix record', async () => {
  reset();
  autoMessageFailures = 1;
  await startFacebookWebhookWorker();

  await enqueueVerifiedFacebookPayload(leadgenPayload('lead-once'));
  assert.ok(await waitFor(() => rows[0].status === 'failed'), 'the step after the post failed');
  assert.equal(sentMessages.length, 1, 'posted once');
  assert.ok(rows[0].telegram_posted_at, 'the post was remembered');
  assert.equal(bitrixLeads.length, 1);

  rows[0].next_retry_at = new Date(Date.now() - 1);
  await enqueueVerifiedFacebookPayload(leadgenPayload('nudge'));
  assert.ok(await waitFor(() => rows[0].status === 'completed'), 'the retry finished the lead');

  const leadPosts = sentMessages.filter((m) => !/^AutoMessage/.test(m.text));
  // One post for lead-once and one for the unrelated nudge lead — never two for lead-once.
  assert.equal(leadPosts.length, 2);
  assert.deepEqual(bitrixLeads, ['lead-once', 'nudge'], 'lead-once reused its CRM record');

  await stopFacebookWebhookWorker();
});

test("a person's Retry gives an abandoned event a fresh budget", async () => {
  reset();
  rows.push({
    id: nextId++,
    event_key: 'leadgen:9001:lead-back',
    page_id: '9001',
    event_type: 'leadgen',
    payload: { pageId: '9001', leadgenId: 'lead-back', value: {} },
    status: 'abandoned',
    attempt_count: 5,
    next_retry_at: new Date(Date.now() - 1),
    last_error: 'expired token',
    telegram_posted_at: null,
  });
  await startFacebookWebhookWorker();

  await retryFacebookWebhookEvent('leadgen:9001:lead-back');
  assert.ok(await waitFor(() => rows[0].status === 'completed'));
  assert.equal(rows[0].attempt_count, 1, 'counted from zero again');

  await stopFacebookWebhookWorker();
});

test('the retry ladder spreads five attempts over more than an hour', () => {
  assert.equal(MAX_EVENT_ATTEMPTS, 5);
  const waits = [1, 2, 3, 4].map((n) => getRetryDelayMs(n));
  assert.deepEqual(waits, [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000]);
  assert.ok(waits.reduce((a, b) => a + b, 0) > 60 * 60_000);
  assert.equal(getRetryDelayMs(99), 60 * 60_000, 'capped');
});

test('the abandoned notice never carries a URL out of an error', () => {
  const text = buildAbandonedNotice(
    { event_type: 'leadgen', event_key: 'leadgen:1:abc', payload: { leadgenId: 'abc' } },
    'request to https://graph.facebook.com/v25.0/abc?access_token=SECRET failed',
  );
  assert.doesNotMatch(text, /SECRET|graph\.facebook\.com/);
  assert.match(text, /abc/);
});
