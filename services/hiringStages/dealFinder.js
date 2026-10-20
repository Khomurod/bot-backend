'use strict';

/**
 * Which Bitrix deal is this candidate's? By phone first, then by name.
 *
 * THE PHONE IS THE STRONG KEY. A recruiter types it in the post, and a lead's
 * contact carries it, so `crm.duplicate.findbycomm` → that contact's open
 * deals is a match on something the candidate gave us. Several deals for one
 * number (the same person posted twice) is still one person: the most
 * recently changed open deal is the one being worked.
 *
 * THE NAME IS THE WEAK ONE. Posted names come in any order ("PHILLIPS SAMUEL
 * JAHBARI"), so a contact matches only when its first AND last name are both
 * among the posted words, and a deal title only when two posted words are in
 * it. Two DIFFERENT people matching is `ambiguous`, and nothing is proposed:
 * a wrong deal moved is worse than a person moving the right one by hand.
 *
 * Only OPEN deals: a closed one is reopened by a person in Bitrix.
 */

const bitrix = require('../bitrix24DealStages');
const { nameParts, hasWord } = require('../../lib/hiringStages/proposal');

const newestFirst = (a, b) => String(b.modifiedAt || '').localeCompare(String(a.modifiedAt || '')) || b.id - a.id;

async function byPhone(phones, opts) {
  const contactIds = await bitrix.findContactIdsByPhone(phones, opts);
  const deals = [];
  for (const id of contactIds.slice(0, 5)) {
    // eslint-disable-next-line no-await-in-loop
    deals.push(...await bitrix.listOpenDealsForContact(id, opts));
  }
  return deals.sort(newestFirst);
}

function contactMatches(contact, parts) {
  const first = nameParts(contact.first);
  const last = nameParts(contact.last);
  return first.length > 0 && last.length > 0
    && [...first.slice(0, 1), ...last].every((w) => parts.includes(w));
}

function titleMatches(title, parts) {
  const text = String(title || '').toLowerCase();
  return parts.filter((w) => hasWord(text, w)).length >= Math.min(2, parts.length);
}

async function byName(name, opts) {
  const parts = nameParts(name);
  if (parts.length < 2) return { deals: [], people: 0 };
  // The two longest words are the likeliest surnames; "jr" and initials are not.
  const words = [...parts].sort((a, b) => b.length - a.length).slice(0, 2);

  const contacts = new Map();
  for (const word of words) {
    // eslint-disable-next-line no-await-in-loop
    for (const c of await bitrix.listContactsByLastName(word, opts)) {
      if (contactMatches(c, parts)) contacts.set(c.id, c);
    }
  }
  const deals = new Map();
  for (const id of [...contacts.keys()].slice(0, 5)) {
    // eslint-disable-next-line no-await-in-loop
    for (const d of await bitrix.listOpenDealsForContact(id, opts)) deals.set(d.id, d);
  }
  for (const d of await bitrix.listOpenDealsByTitle(words[0], opts)) {
    if (titleMatches(d.title, parts)) deals.set(d.id, d);
  }
  // People, not rows: deals of one contact are one person; a deal with no
  // contact counts as its own.
  const people = new Set([...deals.values()].map((d) => (d.contactId ? `c${d.contactId}` : `d${d.id}`)));
  return { deals: [...deals.values()].sort(newestFirst), people: people.size };
}

/**
 * @param {{phones: string[], name: string|null}} candidate
 * @returns {Promise<{status: 'found', deal: object, via: 'phone'|'name'} |
 *   {status: 'none'} | {status: 'ambiguous', count: number}>}
 * @throws {BitrixError} when Bitrix cannot be asked
 */
async function findCandidateDeal({ phones = [], name = null }, opts = {}) {
  if (phones.length) {
    const deals = await byPhone(phones, opts);
    if (deals.length) return { status: 'found', deal: deals[0], via: 'phone' };
  }
  if (name) {
    const { deals, people } = await byName(name, opts);
    if (people > 1) return { status: 'ambiguous', count: people };
    if (deals.length) return { status: 'found', deal: deals[0], via: 'name' };
  }
  return { status: 'none' };
}

module.exports = { findCandidateDeal, __contactMatchesForTests: contactMatches, __titleMatchesForTests: titleMatches };
