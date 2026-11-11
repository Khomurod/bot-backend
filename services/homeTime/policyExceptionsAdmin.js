'use strict';

/**
 * Home Time → Settings & Alerts → drivers' own rules (owner, 11 November
 * 2026: "there can be drivers we made an exception for, like 3 weeks on the
 * road and 3 days home"; anyone with access may set one).
 *
 * The OLD exceptions lived on the drivers' Bitrix pipeline-33 cards (the
 * "allowed days" and "home until" fields, and the "Agreed" stage). They are
 * NOT imported by themselves: `bitrixPreview` lists them, with the driver
 * group each card's name matches, so a person sees them and adds the ones
 * that still apply — what those Bitrix fields meant was the old script's.
 */

const store = require('../../database/homeTime/policyExceptions');
const { callBitrix } = require('../bitrix24DealStages');
const V = require('../../lib/homeTime/violations');
const { sameDriver } = require('../../lib/homeTime/cardMatch');

const MAX_PAGES = 20;
const AGREED_STAGE = 'C33:UC_HTAGREED';

function invalid(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function wholeOrNull(value, { min, max }, what) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw invalid(`${what} must be a whole number from ${min} to ${max}.`);
  return n;
}

async function view(deps = { store }) {
  const [exceptions, groups] = await Promise.all([deps.store.listActiveExceptions(), deps.store.listDriverGroups()]);
  return { exceptions, groups, policy: V.POLICY };
}

async function save(body = {}, by = null, deps = { store }) {
  const groupId = Number(body.groupId);
  if (!Number.isInteger(groupId) || groupId <= 0) throw invalid('Choose the driver.');
  const roadDays = wholeOrNull(body.roadDays, { min: 1, max: 365 }, 'Days on the road');
  const homeDays = wholeOrNull(body.homeDays, { min: 0, max: 365 }, 'Days at home');
  if (roadDays == null && homeDays == null) throw invalid('Set the days on the road, the days at home, or both.');
  const validUntil = body.validUntil ? String(body.validUntil).slice(0, 10) : null;
  if (validUntil && !/^\d{4}-\d{2}-\d{2}$/.test(validUntil)) throw invalid('The end date must be a date.');
  return deps.store.setException({
    groupId, roadDays, homeDays, validUntil, note: body.note ? String(body.note).slice(0, 300) : null,
  }, by);
}

async function remove(id, deps = { store }) {
  if (!(await deps.store.removeException(id))) throw invalid('That rule is already gone.');
  return true;
}

/** The pipeline-33 cards that carried an exception, matched to driver groups by name. Read only. */
async function bitrixPreview(deps = { store, call: callBitrix }) {
  const cards = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await deps.call('crm.deal.list', {
      filter: { CATEGORY_ID: V.CATEGORY_ID },
      select: ['ID', 'TITLE', 'STAGE_ID', V.FIELDS.allowDays, V.FIELDS.homeUntil],
      order: { ID: 'ASC' },
      start: page * 50,
    });
    const batch = Array.isArray(rows) ? rows : [];
    cards.push(...batch);
    if (batch.length < 50) break;
  }
  const groups = await deps.store.listDriverGroups();
  return cards
    .filter((c) => String(c[V.FIELDS.allowDays] ?? '').trim() !== '' || c.STAGE_ID === AGREED_STAGE)
    .map((c) => {
      const matches = groups.filter((g) => sameDriver(c.TITLE, g.driverName || g.name));
      return {
        dealId: Number(c.ID),
        title: c.TITLE,
        agreed: c.STAGE_ID === AGREED_STAGE,
        allowDays: c[V.FIELDS.allowDays] ?? null,
        homeUntil: c[V.FIELDS.homeUntil] ? String(c[V.FIELDS.homeUntil]).slice(0, 10) : null,
        groupId: matches.length === 1 ? matches[0].id : null,
        groupName: matches.length === 1 ? matches[0].name : null,
      };
    });
}

module.exports = {
  view, save, remove, bitrixPreview,
};
