'use strict';

/**
 * What the bot writes in the recruiting group's Bitrix topic, and its
 * buttons. Pure.
 *
 * EVERY MESSAGE NAMES THE DRIVER AND LINKS THE POST. The conversation is read
 * in General and answered in the Bitrix topic (owner, November 2026), so a
 * message there cannot be a reply to the post: it names the driver and ends
 * with a link that opens the recruiter's post in General.
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

/** The last line of every message: the recruiter's post in General. */
function postLine(p) {
  const url = postLink(p.chatId, p.rootMessageId);
  return url ? `🔗 <a href="${esc(url)}">The post in General</a>` : '';
}

const lines = (...parts) => parts.filter(Boolean).join('\n');

/** "Move <driver> to <stage>?" — the proposal a person confirms. */
function moveText(p) {
  return lines(
    `📋 <b>Bitrix:</b> move <b>${who(p)}</b> to <b>${esc(p.toStageName)}</b>?`,
    `Now: ${esc(p.fromStageName || 'unknown')} · ${dealLink(p)}`,
    p.evidence ? `Why: ${quote(p.evidence)}` : '',
    postLine(p),
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
    `⚠️ <b>Bitrix:</b> no open deal found for <b>${who(p)}</b>${phone}.`,
    p.note ? `Not created automatically: ${esc(p.note)}.` : '',
    `${personLink(p.recruiterUserId, p.recruiterName)}, please create the deal in Bitrix — `
      + `the conversation says it should be at <b>${esc(p.toStageName)}</b>.`,
    p.evidence ? `Why: ${quote(p.evidence)}` : '',
    postLine(p),
  );
}

/** The bot created (or completed) the candidate's records in Bitrix. */
function createdText(p) {
  const phone = p.driverPhone ? ` (${esc(p.driverPhone)})` : '';
  const contact = p.contactReused ? 'on the contact that already had this phone' : 'with a new contact';
  return lines(
    `🆕 <b>Bitrix:</b> created a deal for <b>${who(p)}</b>${phone} ${contact} — no open deal existed.`,
    `${dealLink(p)} · at <b>${esc(p.stageName || 'the first stage')}</b>`,
    postLine(p),
  );
}

/** Two or more different people in Bitrix match the name: nothing is proposed or created. */
function ambiguousText(p) {
  return lines(
    `⚠️ <b>Bitrix:</b> ${Number(p.count) || 'several'} different people in Bitrix match <b>${who(p)}</b> — `
      + 'nothing was moved or created. Please move the right deal by hand.',
    postLine(p),
  );
}

/** Bitrix refused, or kept failing: nothing changed. Bitrix's own words, never the webhook. */
function bitrixErrorText(p) {
  return lines(
    `❗ <b>Bitrix error</b> while handling <b>${who(p)}</b> — nothing was changed.`,
    p.error ? `Bitrix said: ${esc(String(p.error).slice(0, 200))}` : '',
    postLine(p),
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

/** The proposal after somebody answered it — no buttons, the post still linked. */
function closedText(p, outcome, extra = {}) {
  return lines(closedLine(p, outcome, extra), postLine(p));
}

function closedLine(p, outcome, { byName = null, detail = null } = {}) {
  const by = byName ? ` — ${esc(byName)}` : '';
  if (outcome === 'superseded' && p.kind === 'create_deal') {
    return `↪️ <s>No open deal for ${who(p)}</s> — replaced by a newer message.`;
  }
  switch (outcome) {
    case 'applied':
      return `✅ <b>${who(p)}</b> moved to <b>${esc(p.toStageName)}</b> in Bitrix${by}.\n${dealLink(p)}`;
    case 'already_there':
      return `✅ <b>${who(p)}</b> is already at <b>${esc(p.toStageName)}</b> in Bitrix.\n${dealLink(p)}`;
    case 'declined':
      return `✖ <b>${who(p)}</b> not moved to <b>${esc(p.toStageName)}</b>${by}.`;
    case 'stale':
      return `⏸ Not moved: <b>${who(p)}</b>'s deal is now at <b>${esc(detail || 'another stage')}</b> — `
        + `somebody changed it in Bitrix.\n${dealLink(p)}`;
    case 'gone':
      return `⏸ Not moved: <b>${who(p)}</b>'s deal no longer exists in Bitrix.`;
    case 'superseded':
      return `↪️ <s>Move ${who(p)} to ${esc(p.toStageName)}</s> — replaced by a newer proposal.`;
    default:
      return esc(detail || '');
  }
}

module.exports = {
  CALLBACK_PREFIX,
  CALLBACK_PATTERN,
  esc,
  moveText,
  moveKeyboard,
  createDealText,
  createDealKeyboard,
  createdText,
  ambiguousText,
  bitrixErrorText,
  closedText,
  postLine,
};
