'use strict';

/**
 * `docs/architecture/ai-decisions.md` is the record of what AI is allowed to
 * change in this application, and which guard stops it going further. It is the
 * document somebody reads after an incident, and the one `CLAUDE.md` points at
 * before anybody touches an AI path.
 *
 * A DOCUMENT LIKE THAT GOES STALE SILENTLY, and silently is exactly how it stops
 * being true: a capability is added, it writes to a table, nobody thinks to
 * record the verdict, and six months later the page confidently describes a
 * system that no longer exists. Nothing fails. Nothing warns.
 *
 * So the catalogue is the source of truth and this file compares the document
 * against it. Adding a capability that can change stored state without writing
 * down what stops it now fails a test instead of nothing.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { CAPABILITIES } = require('../lib/ai/capabilityCatalog');

const DOC = fs.readFileSync(
  require.resolve('../docs/architecture/ai-decisions.md'), 'utf8'
);

test('every capability that can change stored state has a recorded verdict', () => {
  const missing = CAPABILITIES
    .filter((c) => c.changesState)
    .map((c) => c.key)
    .filter((key) => !DOC.includes(key));

  assert.deepEqual(missing, [],
    `add a row to docs/architecture/ai-decisions.md for: ${missing.join(', ')}`);
});

test('a state-changing capability also declares what it writes, in the catalogue', () => {
  for (const cap of CAPABILITIES.filter((c) => c.changesState)) {
    assert.ok(
      typeof cap.stateNote === 'string' && cap.stateNote.length > 20,
      `${cap.key} changes state but does not say what it writes`,
    );
  }
});

test('the document names its own guard, so the table cannot quietly become a list', () => {
  // Each row is "what it decides | what it writes | the guard | the verdict".
  // A row with an empty guard column is the shape of a capability nobody
  // thought about, and it should read as obviously unfinished.
  const rows = DOC.split('\n').filter((l) => l.startsWith('| **'));
  assert.ok(rows.length >= 10, 'the table still has its rows');
  for (const row of rows) {
    const cells = row.split('|').map((c) => c.trim()).filter(Boolean);
    assert.equal(cells.length, 4, `four columns expected: ${cells[0]}`);
    assert.ok(cells[2].length > 20, `${cells[0]} records no guard`);
    assert.ok(/\*\*/.test(cells[3]), `${cells[0]} records no verdict`);
  }
});

test('the hard lines are still written down', () => {
  // Each of these was a decision taken deliberately, and each is enforced in
  // code elsewhere. If somebody removes the sentence, the enforcement has
  // probably gone too.
  for (const line of [
    'Applying any operational correction',
    'Suspending an AI provider',
    'Filling a gap in an annotation',
    'Any employment decision, anywhere',
    'Stating a figure nobody approved',
    'Changing one of its own rules',
  ]) {
    assert.ok(DOC.includes(line), `the document must still refuse: ${line}`);
  }
});

test('a text-only capability is not listed as changing state', () => {
  // The opposite mistake: a row in the state-changing table for something that
  // only words a sentence would make the document alarming rather than useful.
  const wording = CAPABILITIES.filter((c) => !c.changesState).map((c) => c.key);
  const stateSection = DOC.slice(
    DOC.indexOf('## Decisions that can change stored information'),
    DOC.indexOf('## Text only'),
  );
  const wronglyListed = wording.filter((key) => stateSection.includes(`\`${key}\``));
  // `retention_summary` and `recruiting_after_hours_reply` are the deliberate
  // exceptions and are explained in their own rows: one sends an SMS in a
  // person's name, the other is listed to record that it changes nothing.
  const allowed = new Set(['retention_summary', 'recruiting_after_hours_reply']);
  assert.deepEqual(wronglyListed.filter((k) => !allowed.has(k)), []);
});
