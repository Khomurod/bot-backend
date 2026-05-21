#!/usr/bin/env node
/**
 * Discover Bitrix24 lead field API names and INCOMING status id.
 * Usage: BITRIX24_WEBHOOK_URL=https://wenze.bitrix24.com/rest/1/xxx/ node scripts/discover-bitrix-lead-fields.js
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');

const webhookBase = String(process.env.BITRIX24_WEBHOOK_URL || '').trim().replace(/\/?$/, '/');

if (!webhookBase) {
  console.error('Set BITRIX24_WEBHOOK_URL to your incoming webhook base URL.');
  process.exit(1);
}

async function bitrixGet(method, query = '') {
  const url = `${webhookBase}${method}.json${query ? `?${query}` : ''}`;
  const response = await fetch(url);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error) {
    throw new Error(body.error_description || body.error || `HTTP ${response.status}`);
  }
  return body.result;
}

function printFields(result) {
  const entries = Object.entries(result || {}).sort((a, b) => {
    const titleA = (a[1]?.listLabel || a[1]?.title || a[0]).toLowerCase();
    const titleB = (b[1]?.listLabel || b[1]?.title || b[0]).toLowerCase();
    return titleA.localeCompare(titleB);
  });

  console.log('\n--- Lead fields (name | title | type) ---');
  for (const [name, meta] of entries) {
    const title = meta?.listLabel || meta?.title || '';
    const type = meta?.type || '';
    console.log(`${name}\t${title}\t${type}`);
    if (type === 'enumeration' && meta?.items) {
      for (const item of meta.items) {
        console.log(`  enum: ${item.ID} = ${item.VALUE}`);
      }
    }
  }
}

function findIncomingStatus(statuses) {
  const list = Array.isArray(statuses) ? statuses : [];
  return list.find((s) => String(s.NAME || s.name || '').toUpperCase() === 'INCOMING')
    || list.find((s) => String(s.STATUS_ID || s.statusId || '').toUpperCase().includes('INCOMING'));
}

function suggestCustomFields(result) {
  const keywords = ['experience', 'cdl', 'driver', 'years', 'road'];
  const matches = [];
  for (const [name, meta] of Object.entries(result || {})) {
    if (!name.startsWith('UF_CRM')) continue;
    const title = String(meta?.listLabel || meta?.title || '').toLowerCase();
    if (keywords.some((kw) => title.includes(kw))) {
      matches.push({ name, title: meta?.listLabel || meta?.title, type: meta?.type });
    }
  }
  return matches;
}

async function main() {
  console.log('Webhook:', webhookBase);

  const fields = await bitrixGet('crm.lead.fields');
  printFields(fields);

  const statuses = await bitrixGet('crm.status.list', 'filter[ENTITY_ID]=STATUS');
  const incoming = findIncomingStatus(statuses);
  console.log('\n--- Lead statuses (STATUS entity) ---');
  for (const s of statuses || []) {
    console.log(`${s.STATUS_ID}\t${s.NAME}`);
  }
  if (incoming) {
    console.log('\nSuggested INCOMING status:', incoming.STATUS_ID, `(${incoming.NAME})`);
  } else {
    console.log('\nWARNING: No status named INCOMING found. Pick STATUS_ID from list above.');
  }

  const custom = suggestCustomFields(fields);
  if (custom.length) {
    console.log('\n--- Custom fields matching experience/CDL/driver ---');
    for (const row of custom) {
      console.log(`${row.name}\t${row.title}\t${row.type}`);
    }
  }

  const outPath = path.join(__dirname, '..', 'config', 'bitrix24LeadFieldMap.discovered.json');
  const template = {
    statusId: incoming?.STATUS_ID || '',
    custom: Object.fromEntries(
      custom.map((row) => [row.title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''), row.name])
    ),
    note: 'Merge custom keys with actual Meta field_data names from Telegram leads',
  };
  fs.writeFileSync(outPath, `${JSON.stringify(template, null, 2)}\n`);
  console.log(`\nWrote hint file: ${outPath}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
