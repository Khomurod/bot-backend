'use strict';

/**
 * Wenze decides home-time violations itself (owner, 11 November 2026: the
 * external script that moved Bitrix pipeline 33's cards was switched off, and
 * the last alert went out on 31 October).
 *
 *   the record    driver_road_history — the Dispatcher Board (only HOME is
 *                 home) and the drivers' own messages, services/homeTimeService.js
 *   the verdict   lib/homeTime/ownViolations.js: came home early (< 28 days on
 *                 the road), overstayed (> 4 days home), company drivers only,
 *                 a driver's own rule where one is set, an approved request
 *                 is agreed, a flap of a few hours is no stay
 *   the alert     accounting, exactly as before (services/homeTime/
 *                 violationPosting.js) — once per violation per home stay
 *                 (`recordOwnViolations` inserts each once)
 *   the card      the driver's pipeline-33 card is moved to EARLY / OVERSTAY /
 *                 EARLY & OVERSTAYED with its home-time fields filled — found
 *                 by name (lib/homeTime/cardMatch.js, one letter may differ);
 *                 none or two matching: nothing moved, and the row says so
 *
 * FROM LAUNCH, NO BACKLOG (owner): the first pass records when Wenze started
 * deciding (`own_violations_since`) and judges only home stays that begin
 * after it. Exactly one source decides (`violation_source`): while it is
 * 'wenze' the old card-reading pass and its webhook stand down, so a card
 * Wenze moved is never alerted on a second time.
 */

const { violationsFor } = require('../../lib/homeTime/ownViolations');
const { matchCard, searchWord } = require('../../lib/homeTime/cardMatch');
const V = require('../../lib/homeTime/violations');
const { postRows, postDue } = require('./violationPosting');

/** Cycles read this far before the first stay judged, so its road leg has a start. */
const LOOKBACK_DAYS = 120;
const DAY = 24 * 3600 * 1000;

/** Pipeline 33's violation stage for each verdict. */
const STAGE_FOR = Object.freeze({
  early: 'C33:UC_HTEARLY',
  overstay: 'C33:UC_HTREDFLAG',
  both: 'C33:UC_HTEARLYOVER',
});

function log(text) {
  console.log(`[HOME-TIME-VIOLATION] ${text}`);
}

function stageFor(violations) {
  const set = new Set(violations);
  if (set.has('early') && set.has('overstay')) return STAGE_FOR.both;
  return set.has('early') ? STAGE_FOR.early : STAGE_FOR.overstay;
}

/**
 * Why the card moved, for Monitoring → Logs: automatic, Wenze's own verdict
 * on this home stay (the violation rows and the driver's group are the
 * evidence). The card's title is the label, taken out after 60 days.
 */
function cardAudit(stay, card, target, violations, context) {
  return {
    actorKind: 'automatic',
    trigger: 'home_time.violation_card',
    reason: `Wenze judged this home stay a home-time violation (${violations.join(' + ')}): `
      + `${stay.homeDays} day(s) home${stay.roadDays != null ? ` after ${stay.roadDays} day(s) on the road` : ''}.`,
    evidence: {
      groupId: context.groupId ?? null,
      violationIds: Array.isArray(context.violationIds) ? context.violationIds.join(',') : null,
      homeFrom: stay.homeFrom,
      rule: stay.rule || null,
    },
    targetLabel: card.title || null,
    change: [
      { field: 'STAGE_ID', from: card.stageId || null, to: target },
      { field: 'Home from', from: null, to: stay.homeFrom },
      { field: 'Days home', from: null, to: stay.homeDays },
      ...(stay.roadDays != null ? [{ field: 'Days on the road', from: null, to: stay.roadDays }] : []),
    ],
  };
}

/**
 * Move the driver's pipeline-33 card to the stay's violation stage, with its
 * home-time fields. Never throws: the alert is what matters; the note says
 * what happened to the card.
 */
async function moveCard(stay, driverName, allViolations, deps, context = {}) {
  try {
    const word = searchWord(driverName);
    if (!word) return { note: 'no name to find the Bitrix card by' };
    const rows = await deps.bitrix('crm.deal.list', {
      filter: { CATEGORY_ID: V.CATEGORY_ID, '%TITLE': word },
      select: ['ID', 'TITLE', 'STAGE_ID'],
      order: { ID: 'DESC' },
    });
    const found = matchCard(driverName, (Array.isArray(rows) ? rows : []).map((r) => ({ id: Number(r.ID), title: r.TITLE, stageId: r.STAGE_ID })));
    if (found.none) return { note: 'no Bitrix card in pipeline 33 matches this name — not moved' };
    if (found.ambiguous) return { note: `${found.ambiguous} Bitrix cards in pipeline 33 match this name — not moved` };
    const target = stageFor(allViolations);
    const fields = {
      STAGE_ID: target,
      [V.FIELDS.homeFrom]: stay.homeFrom,
      [V.FIELDS.homeDays]: stay.homeDays,
      ...(stay.roadDays != null ? { [V.FIELDS.roadDays]: stay.roadDays } : {}),
    };
    const ok = await deps.bitrix('crm.deal.update', { id: found.card.id, fields, params: { REGISTER_SONET_EVENT: 'Y' } }, {
      audit: cardAudit(stay, found.card, target, allViolations, context),
    });
    return ok === true
      ? { dealId: found.card.id, note: `card moved to ${target}` }
      : { dealId: found.card.id, note: 'Bitrix did not confirm the card move' };
  } catch (err) {
    return { note: `Bitrix card not moved: ${String(err.message).slice(0, 160)}` };
  }
}

/**
 * One pass. @returns a run-ledger summary
 * @param {{telegram, chatId, settings, deps}} args  deps as violationAlerts.js's, plus cycles/exceptions
 */
async function runOwnViolationPass({
  telegram, chatId, settings, deps,
}) {
  const now = deps.now();
  let since = settings.own_violations_since ? new Date(settings.own_violations_since).getTime() : null;
  if (!since) {
    since = new Date(await deps.store.startOwnViolations()).getTime();
    log(`Wenze decides home-time violations from now on (${new Date(since).toISOString()}); nothing earlier is judged.`);
    return { source: 'wenze', started: true, judged: 0, posted: 0 };
  }

  const [cycles, exceptions] = await Promise.all([
    deps.cycles(new Date(since - LOOKBACK_DAYS * DAY).toISOString()),
    deps.exceptions(),
  ]);
  const ruleByGroup = new Map(exceptions.map((e) => [e.groupId, e]));
  const summary = {
    source: 'wenze', drivers: cycles.size, judged: 0, recorded: 0, posted: 0, cardsMoved: 0, cardsNotMoved: 0,
  };

  for (const [groupId, rows] of cycles) {
    const stays = violationsFor(rows, { now, since, exception: ruleByGroup.get(groupId) || null });
    for (const stay of stays) {
      summary.judged += 1;
      const driverName = rows[0]?.driverName || null;
      // eslint-disable-next-line no-await-in-loop
      const inserted = await deps.store.recordOwnViolations({
        groupId, homeFrom: stay.homeFrom, violations: stay.violations, driverName, roadDays: stay.roadDays, homeDays: stay.homeDays, rule: stay.rule,
      });
      if (!inserted.length) continue;
      summary.recorded += inserted.length;
      // eslint-disable-next-line no-await-in-loop
      const sent = await postRows(inserted, { telegram, chatId, deps });
      summary.posted += sent.posted || 0;
      // eslint-disable-next-line no-await-in-loop
      const card = await moveCard(stay, driverName, stay.violations, deps, {
        groupId, violationIds: inserted.map((r) => r.id),
      });
      if (card.dealId && /moved to/.test(card.note)) summary.cardsMoved += 1; else summary.cardsNotMoved += 1;
      // eslint-disable-next-line no-await-in-loop
      await deps.store.setBitrixNote(inserted.map((r) => r.id), card);
    }
  }
  summary.retried = await postDue({ telegram, chatId, deps });
  return summary;
}

module.exports = {
  runOwnViolationPass, moveCard, stageFor, STAGE_FOR, LOOKBACK_DAYS,
};
