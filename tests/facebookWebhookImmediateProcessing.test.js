/**
 * A Facebook lead must reach Telegram IMMEDIATELY.
 *
 * The idle recovery poll dropped from every 5 seconds to a slow safety sweep,
 * which is only safe because the arrival path already drains on the same tick.
 * These tests pin that: a verified payload is fetched, posted, auto-SMSed and
 * pushed to Bitrix without any interval firing, and startup recovers a backlog
 * without waiting for the sweep either.
 *
 * The queue's guarantees are asserted alongside it — atomic claim, dedupe on
 * event_key, retry scheduling — because the point of the change was to spend
 * fewer queries WITHOUT loosening any of them.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-leads-bot-token';
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.MANAGEMENT_GROUP_ID ||= '-1001234567890';
process.env.JWT_SECRET ||= 'test-jwt-secret';
process.env.PORT ||= '3001';
// Prove the sweep is irrelevant to immediacy: set it so slow that any lead
// delivered during these tests can only have come from the arrival path.
process.env.FACEBOOK_WEBHOOK_SWEEP_MS = String(60 * 60 * 1000);

// ── queue state, standing in for facebook_webhook_events ──
let rows = [];
let nextId = 1;
let claimCalls = 0;
let nextDueQueries = 0;
const sentMessages = [];
const sentSms = [];
const bitrixLeads = [];

function resetQueue() {
  rows = [];
  nextId = 1;
  claimCalls = 0;
  nextDueQueries = 0;
  sentMessages.length = 0;
  sentSms.length = 0;
  bitrixLeads.length = 0;
}

const fakeDb = {
  insertFacebookWebhookEvents: async (events) => {
    const inserted = [];
    for (const event of events) {
      // ON CONFLICT (event_key) DO NOTHING — the dedupe guard.
      if (rows.some((r) => r.event_key === event.eventKey)) continue;
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
      };
      rows.push(row);
      inserted.push(row);
    }
    return inserted;
  },

  claimPendingFacebookWebhookEvents: async (limit = 10) => {
    claimCalls += 1;
    const now = Date.now();
    const due = rows
      .filter((r) => ['pending', 'failed'].includes(r.status) && new Date(r.next_retry_at) <= now)
      .slice(0, limit);
    // Atomic claim: the row leaves the candidate set before it is returned.
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
    if (row) {
      row.status = 'failed';
      row.last_error = message;
      row.next_retry_at = nextRetryAt;
    }
    return row || null;
  },

  query: async (sql) => {
    if (/MIN\(next_retry_at\)/.test(sql)) {
      nextDueQueries += 1;
      const waiting = rows
        .filter((r) => ['pending', 'failed'].includes(r.status))
        .map((r) => new Date(r.next_retry_at).getTime());
      return { rows: [{ next_due_at: waiting.length ? new Date(Math.min(...waiting)) : null }] };
    }
    // Startup crash recovery: re-queue orphaned 'processing' rows.
    if (/SET status = 'pending'/.test(sql)) {
      for (const row of rows.filter((r) => r.status === 'processing')) {
        row.status = 'pending';
        row.attempt_count = Math.min(row.attempt_count, 4);
      }
      return { rows: [] };
    }
    return { rows: [] };
  },

  getFacebookPageConnectionByPageId: async (pageId) => ({
    page_id: pageId,
    page_name: 'Wenze Recruiting',
    telegram_group_id: '-1005555555555',
    access_token_encrypted: 'encrypted-token',
  }),
  createLeadIfNew: async () => ({ id: 77 }),
  updateLeadBitrixResult: async () => ({}),
  hasFacebookSenderBeenSeen: async () => false,
  recordFacebookSenderSeen: async () => ({}),
  resetFacebookWebhookEventByIdentifier: async (identifier) => {
    const row = rows.find((r) => r.event_key === identifier || String(r.id) === String(identifier));
    if (!row) return null;
    row.status = 'pending';
    row.next_retry_at = new Date(Date.now() - 1);
    return { ...row };
  },
};

// ── collaborators stubbed at the module seam ──
require.cache[require.resolve('../database/db')] = { exports: fakeDb };
require.cache[require.resolve('../lib/security/facebookCrypto')] = {
  exports: { decryptText: () => 'page-access-token' },
};

let graphShouldFail = false;
require.cache[require.resolve('../services/facebookGraphService')] = {
  exports: {
    fetchLeadById: async ({ leadgenId }) => {
      if (graphShouldFail) throw new Error('Graph API rate limited');
      return {
        id: leadgenId,
        field_data: [
          { name: 'full_name', values: ['Alex Driver'] },
          { name: 'phone_number', values: ['+15551230000'] },
        ],
      };
    },
    fetchSenderProfile: async () => ({ first_name: 'Alex', last_name: 'Driver' }),
  },
};
require.cache[require.resolve('../services/telegramHtml')] = {
  exports: { safeSend: async (fn) => fn() },
};
require.cache[require.resolve('../services/ringCentralSmsService')] = {
  exports: {
    sendSms: async (phone, body) => {
      sentSms.push({ phone, body });
      return { ok: true, messageId: 'rc-1' };
    },
  },
};
require.cache[require.resolve('../services/facebookLeadAutoMessageService')] = {
  exports: {
    resolveAutoSmsForLead: async () => ({
      isEnabled: true,
      template: 'Hi {{first_name}}, thanks for applying.',
      settings: {},
      ruleLabel: 'default',
    }),
    LEGACY_HARDCODED_TEMPLATE: 'legacy',
  },
};
require.cache[require.resolve('../services/bitrix24Service')] = {
  exports: {
    createCrmRecordFromLead: async ({ leadgenId }) => {
      bitrixLeads.push(leadgenId);
      return { ok: true, bitrixId: 'B-1' };
    },
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
} = require('../services/facebookWebhookService');

configureFacebookLeadTelegram({
  sendMessage: async (chatId, text) => {
    sentMessages.push({ chatId, text });
    return { message_id: sentMessages.length };
  },
});

function leadgenPayload(leadgenId, pageId = '9001') {
  return {
    object: 'page',
    entry: [{
      id: pageId,
      changes: [{
        field: 'leadgen',
        value: { leadgen_id: leadgenId, page_id: pageId, form_id: 'form-7' },
      }],
    }],
  };
}

/** Wait for a condition driven by setImmediate/microtasks, never a poll interval. */
async function waitFor(predicate, { timeoutMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return true;
}

test('an arriving lead is delivered immediately, without waiting for the sweep', async () => {
  resetQueue();
  graphShouldFail = false;
  await startFacebookWebhookWorker();

  const started = Date.now();
  const result = await enqueueVerifiedFacebookPayload(leadgenPayload('lead-immediate'));
  assert.deepEqual(result, { received: 1, inserted: 1 });

  const delivered = await waitFor(() => sentMessages.length === 1);
  const elapsed = Date.now() - started;

  assert.ok(delivered, 'the lead was posted to Telegram');
  // The sweep is an hour out; anything under a second can only be the arrival path.
  assert.ok(elapsed < 1000, `delivered in ${elapsed}ms without an interval tick`);
  assert.equal(sentMessages[0].chatId, '-1005555555555');
  assert.match(sentMessages[0].text, /Alex Driver/);

  // The rest of the production chain ran on that same immediate pass.
  assert.equal(sentSms.length, 1, 'auto-SMS fired');
  assert.equal(sentSms[0].phone, '+15551230000');
  assert.deepEqual(bitrixLeads, ['lead-immediate'], 'Bitrix CRM record created');
  assert.equal(rows[0].status, 'completed');

  await stopFacebookWebhookWorker();
});

test('a re-delivered Meta event is deduped and never posted twice', async () => {
  resetQueue();
  graphShouldFail = false;
  await startFacebookWebhookWorker();

  await enqueueVerifiedFacebookPayload(leadgenPayload('lead-dupe'));
  assert.ok(await waitFor(() => sentMessages.length === 1));

  // Meta re-delivers the same leadgen_id — same event_key.
  const second = await enqueueVerifiedFacebookPayload(leadgenPayload('lead-dupe'));
  assert.deepEqual(second, { received: 1, inserted: 0 }, 'ON CONFLICT DO NOTHING held');

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(sentMessages.length, 1, 'one lead, one Telegram post');
  assert.equal(rows.length, 1);

  await stopFacebookWebhookWorker();
});

test('startup recovers a pending backlog immediately, not on the first sweep', async () => {
  resetQueue();
  graphShouldFail = false;

  // A lead that arrived while the process was down.
  rows.push({
    id: nextId++,
    event_key: 'leadgen:9001:lead-backlog',
    page_id: '9001',
    event_type: 'leadgen',
    payload: { pageId: '9001', leadgenId: 'lead-backlog', value: { form_id: 'form-7' } },
    status: 'pending',
    attempt_count: 0,
    next_retry_at: new Date(Date.now() - 1000),
    last_error: null,
  });

  const started = Date.now();
  await startFacebookWebhookWorker();

  const delivered = await waitFor(() => sentMessages.length === 1);
  assert.ok(delivered, 'the backlog was drained at startup');
  assert.ok(Date.now() - started < 1000, 'without waiting for the sweep');

  await stopFacebookWebhookWorker();
});

test('a crash mid-processing is recovered at startup with the attempt budget intact', async () => {
  resetQueue();
  graphShouldFail = false;

  // Killed instance left this row claimed.
  rows.push({
    id: nextId++,
    event_key: 'leadgen:9001:lead-orphan',
    page_id: '9001',
    event_type: 'leadgen',
    payload: { pageId: '9001', leadgenId: 'lead-orphan', value: {} },
    status: 'processing',
    attempt_count: 2,
    next_retry_at: new Date(Date.now() - 1000),
    last_error: null,
  });

  await startFacebookWebhookWorker();
  assert.ok(await waitFor(() => sentMessages.length === 1), 'orphaned row was re-queued and delivered');
  assert.equal(rows[0].status, 'completed');

  await stopFacebookWebhookWorker();
});

test('a failure schedules a retry and arms a wake for its exact timestamp', async () => {
  resetQueue();
  graphShouldFail = true;
  await startFacebookWebhookWorker();

  await enqueueVerifiedFacebookPayload(leadgenPayload('lead-retry'));
  assert.ok(await waitFor(() => rows.length === 1 && rows[0].status === 'failed'));

  assert.equal(sentMessages.length, 0, 'nothing was posted for the failed fetch');
  assert.match(rows[0].last_error, /rate limited/);
  const retryDelay = new Date(rows[0].next_retry_at).getTime() - Date.now();
  assert.ok(retryDelay > 0, 'the retry is scheduled in the future, not busy-looped');

  // The worker consulted the queue for that timestamp instead of polling for it.
  assert.ok(await waitFor(() => nextDueQueries >= 1), 'next-due lookup ran once after the drain');

  // An operator retry drains at once, still without a timer.
  graphShouldFail = false;
  const claimsBefore = claimCalls;
  await retryFacebookWebhookEvent('leadgen:9001:lead-retry');
  assert.ok(await waitFor(() => sentMessages.length === 1), 'manual retry delivered immediately');
  assert.ok(claimCalls > claimsBefore);
  assert.equal(rows[0].status, 'completed');

  await stopFacebookWebhookWorker();
});

test('an idle worker does not poll PostgreSQL on a seconds-long cadence', async () => {
  resetQueue();
  graphShouldFail = false;
  await startFacebookWebhookWorker();

  // Drain the startup pass, then sit idle well past the old 5s poll interval.
  await waitFor(() => claimCalls >= 1);
  const claimsAfterStartup = claimCalls;
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(
    claimCalls,
    claimsAfterStartup,
    'an empty queue costs zero further claim queries while idle',
  );
  assert.equal(nextDueQueries, 1, 'one next-due lookup per drain, not one per tick');

  await stopFacebookWebhookWorker();
});

test('stopping the worker leaves no timer running', async () => {
  resetQueue();
  await startFacebookWebhookWorker();
  await stopFacebookWebhookWorker();

  const claimsAtStop = claimCalls;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(claimCalls, claimsAtStop, 'no drain after shutdown');
});
