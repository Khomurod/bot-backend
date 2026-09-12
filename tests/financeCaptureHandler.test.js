'use strict';

/**
 * The finance handler's two obligations, both of which are about what it does
 * NOT do.
 *
 * IT NEVER CONSUMES A MESSAGE. Capture is an observer. A finance group that is
 * also a driver group — which nobody has forbidden — must keep its home-time,
 * fuel and chat-buffer handling exactly as it was. `next()` is therefore called
 * on every path, including the failing ones.
 *
 * IT CANNOT TAKE THE BOT DOWN. index.js installs an `unhandledRejection` hook
 * that calls process.exit(1), so a rejection escaping a `bot.on('message')`
 * handler stops the whole application. A payment log is not worth the bot, and
 * this is asserted rather than trusted, because the service it calls is allowed
 * to grow new failure modes.
 *
 * Its POSITION is asserted too: registered after the capture pipeline (so the
 * ordinary group handling is unchanged) and before the control channel (so the
 * finance group's traffic is stored before anything can consume it).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HANDLER_PATH = require.resolve('../bot/handlers/financeCaptureHandlers');
const SERVICE_PATH = require.resolve('../services/finance/captureService');

/** Load the handler against a stubbed capture service. */
function load(captureImpl) {
  const calls = [];
  delete require.cache[HANDLER_PATH];
  require.cache[SERVICE_PATH] = {
    id: SERVICE_PATH,
    filename: SERVICE_PATH,
    loaded: true,
    exports: {
      captureFinanceMessage: async (msg, opts) => {
        calls.push({ msg, opts });
        return captureImpl ? captureImpl(msg, opts) : { handled: true, reason: 'captured' };
      },
    },
  };
  const { registerFinanceCaptureHandlers } = require(HANDLER_PATH);
  return { registerFinanceCaptureHandlers, calls };
}

test.after(() => {
  delete require.cache[SERVICE_PATH];
  delete require.cache[HANDLER_PATH];
});

function fakeBot() {
  const handlers = new Map();
  return { handlers, on(event, fn) { handlers.set(event, fn); } };
}

/** Silence the handler's own console while a failing path is exercised. */
async function quietly(fn) {
  const error = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = error; }
}

test('registered after the capture pipeline and before the control channel', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'bot', 'bot.js'), 'utf8');
  const capture = source.indexOf('registerGroupCaptureHandlers(bot);');
  const finance = source.indexOf('registerFinanceCaptureHandlers(bot);');
  const control = source.indexOf('registerControlReplyHandlers(bot);');

  assert.ok(capture > 0 && finance > 0 && control > 0, 'all three are registered');
  assert.ok(finance > capture, 'ordinary group handling must run first, unchanged');
  assert.ok(finance < control, 'a finance message must be stored before anything can consume it');
});

test('an ordinary message is passed on, and handed to the service unchanged', async () => {
  const { registerFinanceCaptureHandlers, calls } = load();
  const bot = fakeBot();
  registerFinanceCaptureHandlers(bot);

  const message = { message_id: 7, chat: { id: -100 }, text: 'money code 1111 2222 3333' };
  let passedOn = false;
  await bot.handlers.get('message')({ message }, () => { passedOn = true; });

  assert.equal(passedOn, true, 'capture is an observer; it never consumes');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].msg, message);
});

test('an edit is captured as an edit', async () => {
  const { registerFinanceCaptureHandlers, calls } = load();
  const bot = fakeBot();
  registerFinanceCaptureHandlers(bot);

  const edited = { message_id: 7, chat: { id: -100 }, text: 'money code 9999 8888 7777' };
  let passedOn = false;
  await bot.handlers.get('edited_message')({ editedMessage: edited }, () => { passedOn = true; });

  assert.equal(passedOn, true);
  assert.equal(calls[0].msg, edited);
  assert.equal(calls[0].opts.isEdit, true, 'a corrected money code is exactly what a ledger is for');
});

test('an edit delivered only on the raw update is still read', async () => {
  const { registerFinanceCaptureHandlers, calls } = load();
  const bot = fakeBot();
  registerFinanceCaptureHandlers(bot);

  const edited = { message_id: 8, chat: { id: -100 }, text: 'corrected' };
  await bot.handlers.get('edited_message')({ update: { edited_message: edited } }, () => {});
  assert.equal(calls[0].msg, edited);
});

test('a thrown capture is swallowed and the message still moves on', async () => {
  const { registerFinanceCaptureHandlers } = load(() => { throw new Error('postgres is gone'); });
  const bot = fakeBot();
  registerFinanceCaptureHandlers(bot);

  let passedOn = false;
  await quietly(() => bot.handlers.get('message')(
    { message: { message_id: 9, chat: { id: -100 } } },
    () => { passedOn = true; },
  ));
  // Not merely "it did not crash": the driver's message must still reach the
  // home-time parser, the fuel monitor and the chat buffer.
  assert.equal(passedOn, true);
});

test('a rejected capture never escapes into unhandledRejection', async () => {
  const { registerFinanceCaptureHandlers } = load(() => Promise.reject(new Error('boom')));
  const bot = fakeBot();
  registerFinanceCaptureHandlers(bot);

  let passedOn = false;
  await quietly(() => bot.handlers.get('message')(
    { message: { message_id: 10, chat: { id: -100 } } },
    () => { passedOn = true; },
  ));
  assert.equal(passedOn, true);

  await quietly(() => bot.handlers.get('edited_message')(
    { editedMessage: { message_id: 10, chat: { id: -100 } } },
    () => {},
  ));
});

test('the handler decides nothing — it holds no chat id, no parser, no query', () => {
  const source = fs.readFileSync(HANDLER_PATH, 'utf8');
  // Every decision belongs in services/finance/captureService.js, where it can
  // be tested without a bot. A gate that grew back here would be a decision
  // nobody could test.
  for (const forbidden of ['finance_settings', 'parseMoneycodeMessage', 'query(', 'isFinanceChat']) {
    assert.equal(source.includes(forbidden), false, `the handler started deciding: ${forbidden}`);
  }
  assert.match(
    source,
    /require\(['"]\.\.\/\.\.\/services\/finance\/captureService['"]\)/,
    'it reaches the service directly, with nothing in between',
  );
});
