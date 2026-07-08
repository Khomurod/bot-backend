/**
 * Tests for database/telegramDocuments.js — the intake pipeline persistence.
 *
 * The raw `pg` query is replaced with a small in-memory emulator that models
 * just the semantics that matter for safety: the UNIQUE(telegram_file_unique_id)
 * dedup, the UNIQUE(media_group_id) batch convergence, and the atomic
 * waiting_confirmation → uploading claim that makes double-clicked buttons safe.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function loadWithFakeDb() {
  const batches = new Map();     // id -> row
  const filesByUnique = new Set(); // telegram_file_unique_id
  const mediaGroups = new Map();  // media_group_id -> batch id
  const attempts = [];
  let batchSeq = 0;
  let fileSeq = 0;

  async function query(text, params) {
    const s = String(text).replace(/\s+/g, ' ').trim();

    // --- batches ---
    if (s.startsWith('INSERT INTO telegram_document_batches')) {
      const [chatId, groupId, userId, username, mediaGroupId] = params;
      if (s.includes('ON CONFLICT (media_group_id)') && mediaGroupId != null && mediaGroups.has(mediaGroupId)) {
        return { rows: [batches.get(mediaGroups.get(mediaGroupId))], rowCount: 1 };
      }
      const id = ++batchSeq;
      const row = {
        id, telegram_chat_id: chatId, group_id: groupId, telegram_user_id: userId,
        sender_username: username, media_group_id: mediaGroupId ?? null,
        status: 'collecting', detected_doc_type: null, datatruck_order_id: null,
        datatruck_load_reference: null, match_confidence: null, confidence: null,
      };
      batches.set(id, row);
      if (mediaGroupId != null) mediaGroups.set(mediaGroupId, id);
      return { rows: [row], rowCount: 1 };
    }
    if (s.startsWith('SELECT * FROM telegram_document_batches WHERE id')) {
      return { rows: batches.has(params[0]) ? [batches.get(params[0])] : [], rowCount: batches.has(params[0]) ? 1 : 0 };
    }
    if (s.startsWith('SELECT * FROM telegram_document_batches')) {
      // findOpenBatchForSender — return newest collecting batch for the sender.
      const [chatId, userId] = params;
      const match = [...batches.values()].reverse().find(
        (b) => b.telegram_chat_id === chatId && b.telegram_user_id === userId
          && b.media_group_id == null && b.status === 'collecting'
      );
      return { rows: match ? [match] : [], rowCount: match ? 1 : 0 };
    }
    if (s.includes("SET status = 'uploading'")) {
      const row = batches.get(params[0]);
      if (row && row.status === 'waiting_confirmation') {
        row.status = 'uploading';
        row.decided_by_user_id = params[1] ?? row.decided_by_user_id;
        row.decided_by_username = params[2] ?? row.decided_by_username;
        return { rows: [row], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (s.startsWith('UPDATE telegram_document_batches SET status = $2') && s.includes("status = 'waiting_confirmation'")) {
      const row = batches.get(params[0]);
      if (row && row.status === 'waiting_confirmation') {
        row.status = params[1];
        return { rows: [row], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (s.startsWith('UPDATE telegram_document_batches SET')) {
      const row = batches.get(params[0]);
      if (!row) return { rows: [], rowCount: 0 };
      // Emulate the whitelisted column assignments in declaration order.
      const cols = [...s.matchAll(/(\w+) = \$(\d+)/g)].map((m) => [m[1], Number(m[2])]);
      for (const [col, idx] of cols) row[col] = params[idx - 1];
      return { rows: [row], rowCount: 1 };
    }

    // --- files ---
    if (s.startsWith('INSERT INTO telegram_document_files')) {
      const uniqueId = params[2];
      if (uniqueId != null && filesByUnique.has(uniqueId)) return { rows: [], rowCount: 0 };
      if (uniqueId != null) filesByUnique.add(uniqueId);
      const row = { id: ++fileSeq, batch_id: params[0], telegram_file_unique_id: uniqueId };
      return { rows: [row], rowCount: 1 };
    }
    if (s.startsWith('SELECT * FROM telegram_document_files')) {
      return { rows: [], rowCount: 0 };
    }

    // --- upload attempts ---
    if (s.startsWith('INSERT INTO datatruck_upload_attempts')) {
      const row = {
        id: attempts.length + 1, batch_id: params[0], order_id: params[1],
        load_reference: params[2], document_type: params[3], sha256: params[4],
        status: params[5], dry_run: params[6],
      };
      attempts.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (s.includes('FROM datatruck_upload_attempts') && s.includes('sha256 = $1')) {
      const [sha, orderId] = params;
      const m = attempts.find((a) => a.sha256 === sha && (a.order_id ?? null) === (orderId ?? null)
        && ['uploaded', 'dry_run'].includes(a.status));
      return { rows: m ? [m] : [], rowCount: m ? 1 : 0 };
    }
    if (s.includes('FROM datatruck_upload_attempts') && s.includes('order_id = $1') && s.includes("status = 'uploaded'")) {
      const [orderId, docType] = params;
      const m = attempts.find((a) => a.order_id === String(orderId) && a.document_type === docType && a.status === 'uploaded');
      return { rows: m ? [m] : [], rowCount: m ? 1 : 0 };
    }
    if (s.includes('FROM datatruck_upload_attempts') && s.includes("status IN ('uploaded','dry_run')")) {
      const [orderId, docType] = params;
      const m = attempts.find((a) => a.order_id === String(orderId) && a.document_type === docType
        && ['uploaded', 'dry_run'].includes(a.status));
      return { rows: m ? [m] : [], rowCount: m ? 1 : 0 };
    }
    if (s.startsWith('UPDATE datatruck_upload_attempts')) {
      const row = attempts.find((a) => a.id === params[0]);
      if (row) { row.status = params[1]; row.datatruck_document_id = params[2] ?? row.datatruck_document_id; }
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    throw new Error(`Unexpected SQL in fake: ${s.slice(0, 80)}`);
  }

  const modPath = path.resolve(__dirname, '../database/telegramDocuments.js');
  const dbPath = path.resolve(__dirname, '../database/db.js');
  delete require.cache[modPath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { query } };
  return require(modPath);
}

test('addFileToBatch dedups by telegram_file_unique_id (2nd add is a no-op)', async () => {
  const docs = loadWithFakeDb();
  const batch = await docs.createBatch({ telegramChatId: -100, telegramUserId: 5 });
  const first = await docs.addFileToBatch(batch.id, { telegramFileUniqueId: 'AQADabc', kind: 'pdf' });
  const second = await docs.addFileToBatch(batch.id, { telegramFileUniqueId: 'AQADabc', kind: 'pdf' });
  assert.ok(first, 'first insert returns a row');
  assert.equal(second, null, 'duplicate unique id returns null');
});

test('getOrCreateBatchForMediaGroup converges on ONE batch per album', async () => {
  const docs = loadWithFakeDb();
  const a = await docs.getOrCreateBatchForMediaGroup({ mediaGroupId: 'MG1', telegramChatId: -100, telegramUserId: 5 });
  const b = await docs.getOrCreateBatchForMediaGroup({ mediaGroupId: 'MG1', telegramChatId: -100, telegramUserId: 5 });
  assert.equal(a.id, b.id);
});

test('claimBatchForUpload is atomic: only the first claim wins', async () => {
  const docs = loadWithFakeDb();
  const batch = await docs.createBatch({ telegramChatId: -100, telegramUserId: 5 });
  await docs.updateBatch(batch.id, { status: 'waiting_confirmation' });
  const first = await docs.claimBatchForUpload(batch.id, { decidedByUserId: 7 });
  const second = await docs.claimBatchForUpload(batch.id, { decidedByUserId: 8 });
  assert.ok(first, 'first claim succeeds');
  assert.equal(first.status, 'uploading');
  assert.equal(second, null, 'second claim (double-click) returns null → "Already handled"');
});

test('markBatchDecision only transitions from waiting_confirmation', async () => {
  const docs = loadWithFakeDb();
  const batch = await docs.createBatch({ telegramChatId: -100, telegramUserId: 5 });
  // Not yet waiting → cannot decide.
  assert.equal(await docs.markBatchDecision(batch.id, { status: 'ignored' }), null);
  await docs.updateBatch(batch.id, { status: 'waiting_confirmation' });
  const ignored = await docs.markBatchDecision(batch.id, { status: 'ignored', decidedByUserId: 9 });
  assert.equal(ignored.status, 'ignored');
});

test('findUploadedAttempt matches by content hash, then by (order, type)', async () => {
  const docs = loadWithFakeDb();
  await docs.recordUploadAttempt({ orderId: '13367', documentType: 'proof_of_delivery', sha256: 'deadbeef', status: 'uploaded' });
  const byHash = await docs.findUploadedAttempt({ orderId: '13367', documentType: 'proof_of_delivery', sha256: 'deadbeef' });
  assert.ok(byHash, 'duplicate detected by hash');
  const byType = await docs.findUploadedAttempt({ orderId: '13367', documentType: 'proof_of_delivery' });
  assert.ok(byType, 'duplicate detected by (order, type)');
  const none = await docs.findUploadedAttempt({ orderId: '99999', documentType: 'bill_of_lading' });
  assert.equal(none, null, 'no false positive for a different load');
});

test('findBotOriginatedUpload recognises our own recent upload (loop prevention)', async () => {
  const docs = loadWithFakeDb();
  await docs.recordUploadAttempt({ orderId: '13367', documentType: 'bill_of_lading', status: 'uploaded' });
  const hit = await docs.findBotOriginatedUpload({ orderId: '13367', documentType: 'bill_of_lading' });
  assert.ok(hit, 'our bot upload is found so the poller can suppress re-forwarding');
  const miss = await docs.findBotOriginatedUpload({ orderId: '13367', documentType: 'proof_of_delivery' });
  assert.equal(miss, null);
});
