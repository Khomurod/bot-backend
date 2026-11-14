'use strict';

/**
 * The CDL step of a read a PERSON ASKED FOR (requested.js; owner, 14 November
 * 2026 — docs/architecture/hiring-cdl-reading.md). Only on a tagged request,
 * only for a post with photos.
 *
 *   nameForCreation(identity)  the post names NOBODY: the CDL is read first,
 *       and its name may create the candidate (with the one typed phone).
 *   end(deal | null)           the read is over. With an open deal in a hiring
 *       pipeline: the CDL is read (once), its name checked against the
 *       post's — or, with no typed name, the contact's — and the values
 *       written: mapped and empty fields with ONE update per record, the
 *       rest in ONE timeline comment on the deal (cdlBitrix.js). Without a
 *       deal: a CDL already read says so; one never read is not read.
 *
 * ONCE. A conversation whose CDL was written is never read again, and one tag
 * is read at most once (database/hiringStages/cdlReads.js) — the conversation
 * is read again on every reply once a person asked. The ending is recorded
 * (status and counts, never a value) and said on the driver's card, once per
 * tag: counts or the reason (lib/hiringStages/cdlWrite.js `cdlLine`).
 *
 * THE VALUES LIVE ONLY HERE, in memory, on their way to Bitrix. Every write is
 * recorded in Monitoring → Logs as the person who asked (`person_reply`,
 * trigger `hiring_stage.cdl`) with field names only (`valuesWithheld`). A
 * Bitrix refusal ends the step — its words are not kept.
 *
 * Never throws: the step must not cost the candidate the deal the read found
 * or created. A failure it cannot name is recorded as `unreadable`.
 */

const reads = require('../../database/hiringStages/cdlReads');
const fieldMap = require('../../database/hiringStages/cdlFieldMap');
const { postNameState, crossCheckName, identityFromCdl } = require('../../lib/hiringStages/cdlName');
const {
  planCdlWrite, commentText, maskedChange, maskedCommentChange, cdlLine,
} = require('../../lib/hiringStages/cdlWrite');
const { isHiringPipeline } = require('../../lib/hiringStages/placeholder');
const { BitrixError } = require('../bitrix24DealStages');
const cdlBitrix = require('./cdlBitrix');
const { readCdl } = require('./cdlReading');
const { notice } = require('./noDeal');

const TRIGGER = 'hiring_stage.cdl';

function defaultDownload(telegram) {
  // eslint-disable-next-line global-require
  const { downloadTelegramFile } = require('../telegram/fileDownload');
  return (fileId, limits) => downloadTelegramFile({ telegram }, fileId, limits);
}

const asContact = (row) => (row ? {
  first: row.NAME || '', last: row.LAST_NAME || '', name: [row.NAME, row.SECOND_NAME, row.LAST_NAME].filter(Boolean).join(' '),
} : null);

/**
 * @param {object} thread   the queue row (requested: `requestMessageId`)
 * @param {object} deps     the reviewer's deps: telegram, settings, fetchImpl; and for tests
 *   `readCdl` (the AI step) and `download`
 * @param {{post: object, phones: string[], requestedBy: object, seen: object}} ctx
 */
function createCdlStep(thread, deps, {
  post, phones, requestedBy, seen,
}) {
  const ids = {
    chatId: thread.chatId, rootMessageId: thread.rootMessageId, requestMessageId: Number(thread.requestMessageId),
  };
  const opts = { fetchImpl: deps.fetchImpl };
  const postName = postNameState(post?.text);
  const images = post?.images || [];
  let allowed = null;
  let memo = null;
  let ended = false;
  let nameFromCdl = false;

  const mayRead = async () => {
    if (ended || !ids.requestMessageId) return false;
    if (allowed === null) allowed = await reads.mayRead(ids.chatId, ids.rootMessageId, ids.requestMessageId);
    return allowed;
  };
  const reading = () => {
    if (!memo) {
      memo = (deps.readCdl || readCdl)({ images }, {
        download: deps.download || defaultDownload(deps.telegram),
      });
    }
    return memo;
  };

  /** Record how this tag's read ended, and say it on the card — once. */
  async function finish(status, by = {}, counts = {}) {
    ended = true;
    await reads.recordRead({
      ...ids, status, providerKey: by.providerKey, model: by.model, nameFromCdl, ...counts,
    });
    const line = cdlLine({
      status, providerLabel: by.providerLabel, written: counts.itemsWritten, inComment: counts.itemsInComment, nameFromCdl,
    });
    if (line) await notice(thread, deps, `cdl:${ids.requestMessageId}`, line, seen.driverName);
  }

  const audit = (deal, contactId, what, change) => ({
    actorKind: 'person_reply',
    actorTelegramId: requestedBy?.userId ?? null,
    actorName: requestedBy?.name || null,
    trigger: TRIGGER,
    reason: `A person in the recruiting group asked for this lead (a reply to its post mentioning the bot); ${what}`,
    evidence: { ...ids, dealId: deal.id, ...(contactId ? { contactId } : {}) },
    targetLabel: seen.driverName || deal.title || null,
    change,
    valuesWithheld: true,
    correlationKey: `hiring_cdl:${ids.chatId}:${ids.rootMessageId}:${ids.requestMessageId}`,
  });

  /** Read the records and the fields, check the name, write. */
  async function write(deal, read) {
    const by = { providerKey: read.providerKey, model: read.model, providerLabel: read.providerLabel };
    const mapping = await fieldMap.getFieldMap();
    const contactId = deal.contactId || null;
    let done = 0;
    let doneItems = [];
    try {
      const [contactRow, dealRow, defs] = await Promise.all([
        contactId ? cdlBitrix.readRecord('contact', contactId, opts) : null,
        mapping.some((m) => m.entity === 'deal') ? cdlBitrix.readRecord('deal', deal.id, opts) : null,
        mapping.length ? cdlBitrix.readFieldLists(opts) : {},
      ]);
      const check = crossCheckName({
        values: read.values, postName: postName.name || null, contact: asContact(contactRow),
      });
      if (check === 'differs') return finish('name_differs', by);
      if (check === 'no_name') return finish('unreadable', by);
      const plan = planCdlWrite({
        values: read.values, mapping, defs, current: { contact: contactRow, deal: dealRow },
      });
      for (const [entity, id] of [['contact', contactId], ['deal', deal.id]]) {
        const fields = plan.updates[entity];
        const codes = Object.keys(fields);
        if (!codes.length) continue;
        const items = plan.written.filter((w) => w.entity === entity).map((w) => w.item);
        // eslint-disable-next-line no-await-in-loop
        await cdlBitrix.updateRecordFields(entity, id, fields, {
          ...opts, audit: audit(deal, contactId, `the ${entity}'s empty fields were filled from the CDL photo.`, maskedChange(codes)),
        });
        done += items.length;
        doneItems = [...doneItems, ...items];
      }
      if (plan.comment.length) {
        await cdlBitrix.addDealComment(deal.id, commentText({ ...by, front: read.front, back: read.back, lines: plan.comment }), {
          ...opts,
          audit: audit(deal, contactId, 'what the CDL photo says that no empty mapped field took went into one comment.',
            maskedCommentChange(plan.comment.map((c) => c.item))),
        });
      }
      return finish('written', by, {
        itemsWritten: done, itemsInComment: plan.comment.length, writtenItems: doneItems, dealId: deal.id, contactId,
      });
    } catch (err) {
      if (!(err instanceof BitrixError)) throw err;
      return finish('bitrix_refused', by, {
        itemsWritten: done, writtenItems: doneItems, dealId: deal.id, contactId,
      });
    }
  }

  async function guarded(what, fn, fallback) {
    try {
      return await fn();
    } catch (err) {
      console.warn(`[HIRING STAGES] the CDL step failed at ${what} (${err?.name || 'error'})`);
      if (!ended && ids.requestMessageId && memo) await finish('unreadable').catch(() => {});
      ended = true;
      return fallback;
    }
  }

  return {
    /** The post names nobody: the CDL's name, as an identity to create with — or null. */
    nameForCreation(identity) {
      return guarded('the name', async () => {
        if (identity?.ok || postName.state !== 'none' || !images.length || !(await mayRead())) return null;
        const read = await reading();
        if (read.status !== 'read') return null;
        const fromCdl = identityFromCdl({ values: read.values, phones });
        if (!fromCdl.ok) return null;
        nameFromCdl = true;
        return fromCdl;
      }, null);
    },

    /** The read is over: write to `deal`, or say what became of a CDL already read. */
    end(deal) {
      return guarded('the write', async () => {
        if (!(await mayRead())) return;
        if (!deal) {
          if (!memo) return; // never read: nothing to say
          const read = await memo;
          await finish(read.status === 'read' ? 'no_deal' : read.status, read);
          return;
        }
        if (postName.state === 'team') return finish('team');
        if (!images.length) return finish('no_photo');
        if (deal.closed || !isHiringPipeline(deal.categoryId)) return finish('not_hiring');
        const read = await reading();
        if (read.status !== 'read') return finish(read.status, read);
        await write(deal, read);
      }, undefined);
    },

    get nameFromCdl() { return nameFromCdl; },
  };
}

module.exports = { createCdlStep, TRIGGER };
