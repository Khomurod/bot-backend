'use strict';

/**
 * What to do about one Board ↔ Bitrix difference, in plain words — and what
 * a person wrote back, understood (owner, 11 November 2026).
 *
 * THE MODEL SEES EVERYTHING ABOUT THE QUESTION (owner, 11 November 2026: "AI
 * sees everything, must see everything"): the difference, the Board lines on
 * the same truck or with a similar name, and the Bitrix deal(s). It may:
 *
 *   advise   write a short recommendation and CHOOSE which of the rule-built
 *            actions (lib/boardBitrix/actions.js) to offer as buttons — it
 *            can never invent one; an index it names that is not offered is
 *            dropped
 *   read     say what a reply means: done, skip, do action N, or information
 *            — and for information, answer in a sentence ("they are a team:
 *            the Board is missing her as the team driver")
 *
 * Nothing a model says is written to Bitrix. A button press goes through
 * services/boardBitrix/apply.js, which re-reads Bitrix first.
 *
 * Without a model: the rule-built actions are offered with the rule's own
 * advice (lib/boardBitrix/wording.js), and a reply that is not "done" or
 * "skip" gets the hint it always got.
 */

const { AiUnavailableError, runCapability } = require('../ai/router');
const { candidateActions } = require('../../lib/boardBitrix/actions');
const { normalizeStageRows } = require('../../lib/boardBitrix/stageCodes');
const { namesCompatible } = require('../../lib/boardBitrix/names');
const { sameTruckNumber } = require('../../lib/boardBitrix/trucks');

const CAPABILITY = 'board_bitrix_advice';
const MAX_BOARD_LINES = 8;

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    run: runCapability,
    call: require('../bitrix24DealStages').callBitrix,
    settings: () => require('../../database/boardBitrix').getSettings(),
    boardRows: () => require('../../database/dispatchBoard').listBoardRows({ presentOnly: true, limit: 5000 }),
  };
  /* eslint-enable global-require */
}

const SYSTEM = [
  'You help a trucking company keep its CRM (Bitrix24) in line with its Dispatcher Board.',
  'THE DISPATCHER BOARD IS THE SOURCE OF TRUTH: who drives, which truck, which fleet, which status.',
  'You are given one difference between them, the Board lines that may be related (same truck, similar',
  'names, team drivers), the Bitrix deal(s), and a numbered list of actions the bot itself can do in Bitrix.',
  'Sometimes the right fix is on the Board, not in Bitrix (for example a team driver missing from the',
  'Board line) — then say so and offer no action.',
  'Write in plain English for a busy office person: one to three short sentences, no codes or ids.',
].join('\n');

const ADVISE_RULES = [
  'Answer with JSON only:',
  '{"recommendation": "what to do and why", "offer": [indexes of the actions worth a button, best first]}',
  'Offer only actions from the list; offer none when a person must fix it by hand or on the Board.',
].join('\n');

const READ_RULES = [
  'A person replied to the question. Say what the reply means. Answer with JSON only:',
  '{"intent": "done" | "skip" | "do" | "info", "action": index or null, "answer": "your reply to them"}',
  '- done: they say they fixed it. skip: they want to leave it for now.',
  '- do: they ask the bot to do one of the listed actions (give its index).',
  '- info: they explain something. Answer in one or two sentences: what that means for the fix,',
  '  given the Board is the source of truth, and what they should do next.',
].join('\n');

function fence(tag, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 1);
  return `<${tag}>\n${String(text).replace(new RegExp(`</?${tag}>`, 'gi'), '')}\n</${tag}>`;
}

/** The deal pipeline's closing stages, by their Bitrix names. */
async function closeStagesOf(schema, deps) {
  if (!schema?.categoryId) return [];
  const raw = await deps.call('crm.status.list', { filter: { ENTITY_ID: `DEAL_STAGE_${Number(schema.categoryId)}` } });
  const { rows } = normalizeStageRows(raw);
  return rows.filter((s) => s.semantics === 'F').sort((a, b) => a.sort - b.sort).map((s) => ({ id: s.id, name: s.name }));
}

/** Board lines on the same truck, or with a name like one in the question. */
function relatedBoardLines(details, rows) {
  const people = [details.board].flat().filter(Boolean);
  const names = [...people.map((p) => p.name), details.deal?.title, ...(details.deals || []).map((d) => d.title)].filter(Boolean);
  const trucks = [...people.map((p) => p.truck), details.deal?.truckNumber, details.truck?.number].filter(Boolean);
  return (rows || []).filter((r) => {
    const rowNames = [r.cleanName, r.driverNameRaw, ...(r.teamMembers || [])].filter(Boolean);
    return trucks.some((t) => r.truckNorm && sameTruckNumber(r.truckNorm, t))
      || rowNames.some((n) => names.some((m) => namesCompatible(n, m)));
  }).slice(0, MAX_BOARD_LINES).map((r) => ({
    driver: r.driverNameRaw, team: r.teamMembers?.length ? r.teamMembers : undefined, truck: r.truckRaw,
    fleet: r.fleetType, status: r.status, dispatcher: r.dispatcher || undefined, notes: r.notes || undefined,
  }));
}

const listActions = (actions) => actions.map((a, i) => `${i}: ${a.label}`).join('\n') || '(none)';

/**
 * @param {object} details  the discrepancy
 * @returns {Promise<{recommendation: string|null, actions: object[], model: string|null}>} never throws
 */
async function adviseOn(details, deps = defaultDeps()) {
  let actions = [];
  let boardLines = [];
  try {
    const schema = (await deps.settings())?.schemaMapping || null;
    const closeStages = schema && details?.kind === 'not_on_board' ? await closeStagesOf(schema, deps) : [];
    actions = schema ? candidateActions(details, { schema, closeStages }) : [];
    boardLines = relatedBoardLines(details, await deps.boardRows());
  } catch (err) {
    console.warn('[BOARD-BITRIX] advice facts could not be read:', String(err.message).slice(0, 160));
  }
  try {
    const answer = await deps.run({
      capability: CAPABILITY,
      systemText: `${SYSTEM}\n\n${ADVISE_RULES}`,
      userText: [fence('difference', details), fence('board_lines', boardLines), fence('actions', listActions(actions))].join('\n\n'),
      expects: 'json',
      validate: (_t, p) => (p && typeof p.recommendation === 'string' ? true : { message: '"recommendation" is required' }),
    });
    if (answer?.uncertain || !answer?.parsed) return { recommendation: null, actions, model: null };
    const offer = [...new Set((Array.isArray(answer.parsed.offer) ? answer.parsed.offer : []).map(Number))]
      .filter((i) => Number.isInteger(i) && actions[i]);
    return {
      recommendation: String(answer.parsed.recommendation).replace(/\s+/g, ' ').trim().slice(0, 400) || null,
      actions: offer.map((i) => actions[i]),
      model: answer.model || null,
    };
  } catch (err) {
    if (!(err instanceof AiUnavailableError)) console.warn('[BOARD-BITRIX] advice failed:', String(err.message).slice(0, 160));
    return { recommendation: null, actions, model: null };
  }
}

/**
 * What a reply means. Null when no model could say (the caller keeps its rules).
 * @returns {Promise<{intent: string, action: number|null, answer: string|null}|null>}
 */
async function readReplyWithAi({ details, advice, text }, deps = defaultDeps()) {
  try {
    const actions = advice?.actions || [];
    const answer = await deps.run({
      capability: CAPABILITY,
      systemText: `${SYSTEM}\n\n${READ_RULES}`,
      userText: [
        fence('difference', details), fence('recommendation', advice?.recommendation || ''),
        fence('actions', listActions(actions)), fence('reply', text),
      ].join('\n\n'),
      expects: 'json',
      validate: (_t, p) => (p && ['done', 'skip', 'do', 'info'].includes(p.intent) ? true : { message: 'unknown intent' }),
    });
    if (answer?.uncertain || !answer?.parsed) return null;
    const p = answer.parsed;
    const index = Number(p.action);
    const action = p.intent === 'do' && Number.isInteger(index) && actions[index] ? index : null;
    return {
      intent: p.intent === 'do' && action === null ? 'info' : p.intent,
      action,
      answer: p.answer ? String(p.answer).replace(/\s+/g, ' ').trim().slice(0, 500) : null,
    };
  } catch (err) {
    if (!(err instanceof AiUnavailableError)) console.warn('[BOARD-BITRIX] reply reading failed:', String(err.message).slice(0, 160));
    return null;
  }
}

module.exports = {
  CAPABILITY, adviseOn, readReplyWithAi, relatedBoardLines, closeStagesOf,
};
