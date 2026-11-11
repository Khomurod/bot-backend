'use strict';

/**
 * What the bot writes in the recruiting group's Bitrix topic, and its
 * buttons. Pure.
 *
 * ONE CARD PER DRIVER (owner, 11 November 2026: "the bot must not spam the
 * group"). Everything about one candidate — the deal created, each question
 * and how it was answered, a Bitrix error — lives in ONE message: a header
 * with the driver's name and a link to the post in General, a short history,
 * and the question open now with its buttons (`cardText`). A new question
 * re-posts the card at the bottom of the topic; an answer edits it in place
 * (services/hiringStages/card.js).
 *
 * ONE NAME. The card's name is set once — the name read off the post — and
 * every line under it says "the deal", never a second spelling.
 *
 * EVERYTHING IN A MESSAGE IS EITHER BITRIX'S OR QUOTED. The driver's name is
 * as written in the conversation, the deal title and stage names are Bitrix's
 * own, and the reason is somebody's words in quotation marks — nothing a model
 * wrote in its own words reaches the group. All of it is HTML-escaped: it is
 * text other people typed.
 *
 * Callback data is `hst:<action>:<proposal id>` — ok (move it), no (leave
 * it), re (search Bitrix again). Well inside Telegram's 64 bytes.
 */

const { postLink } = require('../safetyApprovals/announcement');

const CALLBACK_PREFIX = 'hst';
const CALLBACK_PATTERN = /^hst:(ok|no|re):(\d+)$/;
/** History lines a card shows; older ones are dropped from the message, never from the database. */
const HISTORY_SHOWN = 6;

function esc(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function quote(evidence) {
  const text = String(evidence || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return `“${esc(text.length > 160 ? `${text.slice(0, 157)}…` : text)}”`;
}

function dealLink(p) {
  const title = esc(p.dealTitle || `Deal #${p.dealId}`);
  return p.dealUrl ? `<a href="${esc(p.dealUrl)}">${title}</a>` : title;
}

function who(p) {
  return esc(p.driverName || p.dealTitle || 'this candidate');
}

function personLink(userId, name) {
  const label = esc(name || 'Recruiter');
  return userId ? `<a href="tg://user?id=${esc(userId)}">${label}</a>` : label;
}

/** The recruiter's post in General. */
function postLine(p) {
  const url = postLink(p.chatId, p.rootMessageId);
  return url ? `🔗 <a href="${esc(url)}">The post in General</a>` : '';
}

const lines = (...parts) => parts.filter(Boolean).join('\n');

// ── the question open now ────────────────────────────────────────────────────

/** "Move the deal to <stage>?" — the proposal a person confirms. */
function moveText(p) {
  return lines(
    `📋 Move to <b>${esc(p.toStageName)}</b>?`,
    `Now: ${esc(p.fromStageName || 'unknown')} · ${dealLink(p)}`,
    p.evidence ? `Why: ${quote(p.evidence)}` : '',
  );
}

function moveKeyboard(id, toStageName) {
  const label = `✅ Move to ${String(toStageName || '').slice(0, 40)}`;
  return {
    inline_keyboard: [[
      { text: label, callback_data: `${CALLBACK_PREFIX}:ok:${id}` },
      { text: '✖ No', callback_data: `${CALLBACK_PREFIX}:no:${id}` },
    ]],
  };
}

/**
 * No deal found, and the bot could not create one itself (the note says why):
 * ask the recruiter who posted the candidate to create it.
 */
function createDealText(p) {
  const phone = p.driverPhone ? ` (${esc(p.driverPhone)})` : '';
  return lines(
    `⚠️ No open deal in Bitrix${phone}.`,
    p.note ? `Not created automatically: ${esc(p.note)}.` : '',
    `${personLink(p.recruiterUserId, p.recruiterName)}, please create the deal in Bitrix — `
      + `the conversation says it should be at <b>${esc(p.toStageName)}</b>.`,
    p.evidence ? `Why: ${quote(p.evidence)}` : '',
  );
}

function createDealKeyboard(id) {
  return {
    inline_keyboard: [[
      { text: '🔄 Deal created — search again', callback_data: `${CALLBACK_PREFIX}:re:${id}` },
      { text: '✖ Skip', callback_data: `${CALLBACK_PREFIX}:no:${id}` },
    ]],
  };
}

// ── one-line history entries ─────────────────────────────────────────────────

/** The bot created (or completed) the candidate's records in Bitrix. */
function createdLine(p) {
  const contact = p.contactReused ? 'on the contact that already had this phone' : 'with a new contact';
  return `🆕 Deal created ${contact} — ${dealLink(p)} at <b>${esc(p.stageName || 'its first stage')}</b>`;
}

/** Two or more different people in Bitrix match the name: nothing is proposed or created. */
function ambiguousLine(p) {
  return `⚠️ ${Number(p.count) || 'Several'} different people in Bitrix match this name — `
    + 'nothing was moved or created. Please move the right deal by hand.';
}

/** Bitrix refused, or kept failing: nothing changed. Bitrix's own words, never the webhook. */
function bitrixErrorLine(p) {
  const said = p.error ? ` Bitrix said: ${esc(String(p.error).slice(0, 200))}` : '';
  return `❗ Bitrix error — nothing was changed.${said}`;
}

/** How an answered question reads in the history. Null for one that leaves no trace. */
function outcomeLine(p, outcome, { byName = null, detail = null } = {}) {
  const by = byName ? ` — ${esc(byName)}` : '';
  switch (outcome) {
    case 'applied':
      return `✅ Moved to <b>${esc(p.toStageName)}</b>${by}`;
    case 'already_there':
      return `✅ Already at <b>${esc(p.toStageName)}</b>`;
    case 'declined':
      return p.kind === 'create_deal' ? `✖ Not creating the deal${by}` : `✖ Not moved to <b>${esc(p.toStageName)}</b>${by}`;
    case 'stale':
      return `⏸ Not moved to <b>${esc(p.toStageName)}</b>: the deal is now at <b>${esc(detail || 'another stage')}</b>`;
    case 'gone':
      return '⏸ Not moved: the deal no longer exists in Bitrix';
    case 'superseded':
      return null;
    default:
      return detail ? esc(detail) : null;
  }
}

/** A question answered BEFORE cards existed: its own message, closed in place. */
function closedText(p, outcome, extra = {}) {
  const line = outcomeLine(p, outcome, extra) || `↪️ <s>${esc(p.toStageName)}</s> — replaced by a newer message`;
  return lines(`<b>${who(p)}</b>: ${line}`, dealLink(p), postLine(p));
}

// ── the card ─────────────────────────────────────────────────────────────────

/**
 * @param {{driverName, chatId, rootMessageId, history: string[], current: string|null}} card
 */
function cardText(card) {
  const history = (card.history || []).filter(Boolean).slice(-HISTORY_SHOWN);
  const post = postLink(card.chatId, card.rootMessageId);
  const header = `👤 <b>${esc(card.driverName || 'Driver candidate')}</b>`
    + (post ? ` · <a href="${esc(post)}">post in General</a>` : '');
  return [header, history.join('\n'), card.current || ''].filter(Boolean).join('\n\n');
}

module.exports = {
  CALLBACK_PREFIX,
  CALLBACK_PATTERN,
  HISTORY_SHOWN,
  esc,
  moveText,
  moveKeyboard,
  createDealText,
  createDealKeyboard,
  createdLine,
  ambiguousLine,
  bitrixErrorLine,
  outcomeLine,
  closedText,
  cardText,
  postLine,
};
