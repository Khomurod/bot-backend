'use strict';

/**
 * EVERY BITRIX WRITE CALL SITE PASSES AN AUDIT CONTEXT (Monitoring → Logs,
 * docs/architecture/activity-log.md).
 *
 * At runtime a write without one is still recorded — as "unknown", so a
 * missing context can never block a write — and this test is what keeps that
 * from being the normal case: it reads every module under services/, server/
 * and bot/ and fails on
 *
 *   - a `*.add|update|delete` call (any Bitrix namespace — `crm.deal.update`,
 *     `tasks.task.add`, `user.update`) whose arguments carry no `audit`;
 *   - a call of a client write helper (`moveDealToStage`, `renameDeal`,
 *     `renameContact`, `createContact`, `createDeal`, `createCrmRecordFromLead`)
 *     whose arguments carry no `audit`;
 *   - a write method built from a template (`crm.${x}.update`), which no scan
 *     can check;
 *   - a raw webhook request to a write method outside the two clients — a
 *     write that would bypass the recorder altogether.
 *
 * Inside services/bitrix24DealStages.js the helpers pass the caller's `opts`
 * (which carries `audit`) to `call`, which records every write.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DIRS = ['services', 'server', 'bot'];
const CLIENT_STAGES = path.join('services', 'bitrix24DealStages.js');
const CLIENT_LEADS = path.join('services', 'bitrix24Service.js');
const HELPERS = ['moveDealToStage', 'renameDeal', 'renameContact', 'createContact', 'createDeal', 'createCrmRecordFromLead'];
/** A write method as a literal argument: `name('crm.deal.update'`, `x.call("tasks.task.add"`. */
const LITERAL_WRITE = /[\w$.]+\(\s*(['"])[a-z]\w*(?:\.\w+)*\.(?:add|update|delete)\1/gi;
/** A write method built from a template — no scan can say which. */
const TEMPLATE_WRITE = /`[^`\s]*\$\{[^`]*\.(?:add|update|delete)`/g;
/** A raw webhook request to a write method. */
const RAW_WRITE = /[a-z]\w*(?:\.\w+)*\.(?:add|update|delete)\.json/gi;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'public') walk(full, out);
    } else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/** The text between the call's `(` at `open` and its matching `)`. */
function argsAt(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    if (c === '\'' || c === '"' || c === '`') {
      const quote = c;
      i += 1;
      while (i < src.length && src[i] !== quote) i += src[i] === '\\' ? 2 : 1;
    } else if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return src.slice(open + 1);
}

const lineOf = (src, index) => src.slice(0, index).split('\n').length;
/** A match on a comment line (`// …`, ` * …`) is prose, not a call. */
const inComment = (src, index) => /^\s*(\/\/|\*|\/\*)/.test(src.slice(src.lastIndexOf('\n', index) + 1, index));

function scan() {
  const literal = [];
  const helpers = [];
  const problems = [];
  for (const file of DIRS.flatMap((d) => walk(path.join(ROOT, d)))) {
    const rel = path.relative(ROOT, file);
    const src = fs.readFileSync(file, 'utf8');
    const isClient = rel === CLIENT_STAGES || rel === CLIENT_LEADS;

    for (const m of src.matchAll(LITERAL_WRITE)) {
      if (inComment(src, m.index)) continue;
      const args = argsAt(src, m.index + m[0].indexOf('('));
      const where = `${rel}:${lineOf(src, m.index)}`;
      literal.push(where);
      // In the client, a helper passes its caller's `opts` (with `audit`) on.
      const ok = rel === CLIENT_STAGES ? /\bopts\b/.test(args) : /\baudit\b/.test(args);
      if (!ok) problems.push(`${where}: a Bitrix write without an audit context`);
    }
    for (const m of src.matchAll(TEMPLATE_WRITE)) {
      problems.push(`${rel}:${lineOf(src, m.index)}: a write method built from a template cannot be checked`);
    }
    if (!isClient) {
      for (const m of src.matchAll(RAW_WRITE)) {
        problems.push(`${rel}:${lineOf(src, m.index)}: a raw request to a Bitrix write bypasses the recorder`);
      }
    }
    for (const m of src.matchAll(new RegExp(`(?<![\\w$])(${HELPERS.join('|')})\\s*\\(`, 'g'))) {
      const before = src.slice(Math.max(0, m.index - 16), m.index);
      if (/function\s+$/.test(before) || inComment(src, m.index)) continue; // the definition, or prose
      const args = argsAt(src, m.index + m[0].indexOf('('));
      const where = `${rel}:${lineOf(src, m.index)}`;
      helpers.push(where);
      if (!/\baudit\b/.test(args)) problems.push(`${where}: ${m[1]}() without an audit context`);
    }
  }
  return { literal, helpers, problems };
}

test('every Bitrix write call site passes an audit context', () => {
  const { literal, helpers, problems } = scan();
  // The scan must find the real sites, or it proves nothing: the Board ↔
  // Bitrix fix and status sync, the home-time card, the five helpers inside
  // the client, and the hiring / Facebook callers of the helpers.
  assert.ok(literal.length >= 8, `found only ${literal.length} literal write sites: ${literal.join(', ')}`);
  assert.ok(helpers.length >= 6, `found only ${helpers.length} helper calls: ${helpers.join(', ')}`);
  assert.deepEqual(problems, []);
});

test('both clients record what they write', () => {
  const stages = fs.readFileSync(path.join(ROOT, CLIENT_STAGES), 'utf8');
  assert.match(stages, /isBitrixWrite\(method\)/);
  assert.match(stages, /recordBitrixWrite/);
  const leads = fs.readFileSync(path.join(ROOT, CLIENT_LEADS), 'utf8');
  assert.match(leads, /recordBitrixWrite/);
  // The lead's fields (phone, e-mail, answers) never reach the recorder.
  assert.doesNotMatch(leads, /record\(\{[^}]*\bfields\b/);
});

test('the scanner catches what it says it catches — in any Bitrix namespace', () => {
  const sample = "deps.call('crm.deal.update', { id: 1, fields: { A: 1 } });\n"
    + "deps.call('crm.deal.update', { id: 1 }, { audit });\n"
    + "callBitrix('tasks.task.add', { fields: {} });\n"
    + "callBitrix(\"user.update\", { ID: 1 }, { audit });\n"
    + "deps.call('crm.deal.get', { id: 1 });\n";
  const found = [...sample.matchAll(LITERAL_WRITE)]
    .map((m) => /\baudit\b/.test(argsAt(sample, m.index + m[0].indexOf('('))));
  assert.deepEqual(found, [false, true, false, true], 'four writes, two without audit; the read is not one');
  assert.equal([...'call(`tasks.${what}.add`, p)'.matchAll(TEMPLATE_WRITE)].length, 1);
  assert.equal([...'fetch(`${base}im.notify.system.add.json`)'.matchAll(RAW_WRITE)].length, 1);
});
