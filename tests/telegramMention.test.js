const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildMention,
  buildDisplayName,
  createMentionResolver,
  normalizeUsername,
  normalizeUserId,
} = require('../services/telegramMention');

// ─── buildMention: username present ───

test('buildMention prefers @username when present', () => {
  assert.equal(
    buildMention({ username: 'driver_joe', telegram_user_id: 123, first_name: 'Joe' }),
    '@driver_joe'
  );
});

test('buildMention strips a leading @ from a stored username', () => {
  assert.equal(buildMention({ username: '@driver_joe' }), '@driver_joe');
});

// ─── buildMention: username absent → inline HTML mention ───

test('buildMention falls back to a tg://user?id inline mention when no username', () => {
  assert.equal(
    buildMention({ telegram_user_id: 987654321, first_name: 'Jane', last_name: 'Doe' }),
    '<a href="tg://user?id=987654321">Jane Doe</a>'
  );
});

test('buildMention accepts a bare `id` field as the numeric id', () => {
  assert.equal(
    buildMention({ id: 42, first_name: 'Al' }),
    '<a href="tg://user?id=42">Al</a>'
  );
});

test('buildMention uses opts.fallbackName for the inline anchor label', () => {
  assert.equal(
    buildMention({ telegram_user_id: 5 }, { fallbackName: 'Night Dispatch' }),
    '<a href="tg://user?id=5">Night Dispatch</a>'
  );
});

// ─── buildMention: HTML escaping ───

test('buildMention HTML-escapes the display name in the inline mention', () => {
  assert.equal(
    buildMention({ telegram_user_id: 7, first_name: 'A<b>&', last_name: '"x"' }),
    '<a href="tg://user?id=7">A&lt;b&gt;&amp; &quot;x&quot;</a>'
  );
});

test('buildMention escapes a plain-text fallback when there is no username or id', () => {
  assert.equal(buildMention({ first_name: 'Tom & <Jerry>' }), 'Tom &amp; &lt;Jerry&gt;');
});

test('buildMention returns escaped generic fallback for an empty user', () => {
  assert.equal(buildMention({}), 'there');
  assert.equal(buildMention(null), 'there');
});

// ─── numeric id validation ───

test('normalizeUserId rejects non-positive-integer ids', () => {
  assert.equal(normalizeUserId('123'), '123');
  assert.equal(normalizeUserId(123), '123');
  assert.equal(normalizeUserId(0), null);
  assert.equal(normalizeUserId(-5), null);
  assert.equal(normalizeUserId('12a'), null);
  assert.equal(normalizeUserId(null), null);
});

test('buildMention ignores an invalid id and falls back to escaped name', () => {
  assert.equal(buildMention({ telegram_user_id: 'not-a-number', first_name: 'X' }), 'X');
});

// ─── buildDisplayName ───

test('buildDisplayName prefers first+last, then username, then fallback', () => {
  assert.equal(buildDisplayName({ first_name: 'A', last_name: 'B' }), 'A B');
  assert.equal(buildDisplayName({ username: 'nick' }), 'nick');
  assert.equal(buildDisplayName({}), 'there');
  assert.equal(buildDisplayName({}, 'Driver'), 'Driver');
});

test('normalizeUsername trims and drops a leading @', () => {
  assert.equal(normalizeUsername('  @bob '), 'bob');
  assert.equal(normalizeUsername(''), null);
  assert.equal(normalizeUsername(null), null);
});

// ─── DB-backed resolver (mocked db) ───

function mockDb({ byId = {}, byName = {} } = {}) {
  return {
    calls: { getDriverByTelegramId: [], findDriverByName: [] },
    async getDriverByTelegramId(id) {
      this.calls.getDriverByTelegramId.push(id);
      return byId[String(id)] || undefined;
    },
    async findDriverByName(name) {
      this.calls.findDriverByName.push(name);
      return byName[String(name).toLowerCase()] || undefined;
    },
  };
}

test('resolver.mentionForTelegramId returns @username when the stored user has one', async () => {
  const db = mockDb({ byId: { 100: { telegram_user_id: 100, username: 'stored_joe' } } });
  const resolver = createMentionResolver(db);
  assert.equal(await resolver.mentionForTelegramId(100), '@stored_joe');
  assert.deepEqual(db.calls.getDriverByTelegramId, ['100']);
});

test('resolver.mentionForTelegramId builds an inline mention when the user has no username', async () => {
  const db = mockDb({
    byId: { 200: { telegram_user_id: 200, first_name: 'No', last_name: 'Handle' } },
  });
  const resolver = createMentionResolver(db);
  assert.equal(
    await resolver.mentionForTelegramId(200),
    '<a href="tg://user?id=200">No Handle</a>'
  );
});

test('resolver.mentionForTelegramId builds an inline mention from the id when the user is unknown', async () => {
  const db = mockDb();
  const resolver = createMentionResolver(db);
  assert.equal(
    await resolver.mentionForTelegramId(300, { fallbackName: 'Unknown Driver' }),
    '<a href="tg://user?id=300">Unknown Driver</a>'
  );
});

test('resolver.mentionForTelegramId returns escaped fallback for an invalid id', async () => {
  const db = mockDb();
  const resolver = createMentionResolver(db);
  assert.equal(await resolver.mentionForTelegramId('nope', { fallbackName: 'A&B' }), 'A&amp;B');
  assert.deepEqual(db.calls.getDriverByTelegramId, []);
});

test('resolver.mentionForTelegramId survives a db error and falls back to the id mention', async () => {
  const resolver = createMentionResolver({
    async getDriverByTelegramId() {
      throw new Error('db down');
    },
  });
  assert.equal(
    await resolver.mentionForTelegramId(400, { fallbackName: 'Someone' }),
    '<a href="tg://user?id=400">Someone</a>'
  );
});

test('resolver.mentionForName returns an inline mention when the user is found by name', async () => {
  const db = mockDb({
    byName: { 'jane doe': { telegram_user_id: 555, first_name: 'Jane', last_name: 'Doe' } },
  });
  const resolver = createMentionResolver(db);
  assert.equal(
    await resolver.mentionForName('Jane Doe'),
    '<a href="tg://user?id=555">Jane Doe</a>'
  );
});

test('resolver.mentionForName returns @username when the found user has one', async () => {
  const db = mockDb({ byName: { bob: { username: 'bob_the_driver' } } });
  const resolver = createMentionResolver(db);
  assert.equal(await resolver.mentionForName('@bob'), '@bob_the_driver');
  assert.deepEqual(db.calls.findDriverByName, ['bob']);
});

test('resolver.mentionForName falls back to the escaped name when nobody is found', async () => {
  const db = mockDb();
  const resolver = createMentionResolver(db);
  assert.equal(await resolver.mentionForName('Ghost <User>'), 'Ghost &lt;User&gt;');
});

test('resolver.mentionForName returns empty string for a blank name', async () => {
  const resolver = createMentionResolver(mockDb());
  assert.equal(await resolver.mentionForName('   '), '');
});
