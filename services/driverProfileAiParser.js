/**
 * AI-assisted parsing of driver Telegram group names into profile fields:
 * unit number, first/last names, optional secondary team-driver names, and driver type.
 *
 * The AI reads each group name and applies the company's own naming convention:
 *   - if the name marks the driver as a COMPANY DRIVER → driver_type "company_driver"
 *   - otherwise (an owner operator) → driver_type "owner"
 *
 * The deterministic parser (driverProfileParse) is the fallback for any group the
 * AI misses or when the AI is unavailable, so the result is always complete.
 */
const { callGeminiJson } = require('./geminiClient');
const { parseDriverFromGroupName, stripStatusWords } = require('./driverProfileParse');

function normalizeType(value) {
  return String(value || '').toLowerCase().includes('company') ? 'company_driver' : 'owner';
}

/** Trim, drop any appended status word ("INACTIVE"), and null out empties. */
function cleanStr(value) {
  const s = stripStatusWords(String(value == null ? '' : value).trim());
  return s ? s : null;
}

/**
 * Parse a list of groups [{ id, group_name }] into profile fields.
 * Always returns one result per input group (AI result merged over the
 * deterministic fallback), shaped:
 *   {
 *     group_id, group_name, unit_number,
 *     first_name, last_name, secondary_first_name, secondary_last_name,
 *     driver_type, source
 *   }
 */
async function parseGroups(groups) {
  const list = (Array.isArray(groups) ? groups : []).filter((g) => g && g.id);
  if (!list.length) return [];

  // Deterministic baseline for every group (also the fallback).
  const baseline = new Map();
  for (const g of list) {
    baseline.set(Number(g.id), {
      group_id: Number(g.id),
      group_name: g.group_name || '',
      ...parseDriverFromGroupName(g.group_name || ''),
      source: 'fallback',
    });
  }

  let aiByGroupId = new Map();
  try {
    aiByGroupId = await parseWithAi(list);
  } catch (err) {
    console.warn('[DRIVER-AI-PARSE] AI parse failed, using deterministic fallback:', err.message);
  }

  return list.map((g) => {
    const base = baseline.get(Number(g.id));
    const ai = aiByGroupId.get(Number(g.id));
    if (!ai) return base;
    return {
      group_id: Number(g.id),
      group_name: g.group_name || '',
      // Prefer AI values, fall back to deterministic when AI left a field empty.
      unit_number: cleanStr(ai.unit_number) || base.unit_number,
      first_name: cleanStr(ai.first_name) || base.first_name,
      last_name: cleanStr(ai.last_name) || base.last_name,
      secondary_first_name: cleanStr(ai.secondary_first_name) || base.secondary_first_name,
      secondary_last_name: cleanStr(ai.secondary_last_name) || base.secondary_last_name,
      driver_type: ai.driver_type || base.driver_type,
      source: 'ai',
    };
  });
}

async function parseWithAi(list) {
  // Chunk to keep prompts small and resilient.
  const CHUNK = 40;
  const out = new Map();
  for (let i = 0; i < list.length; i += CHUNK) {
    const chunk = list.slice(i, i + CHUNK);
    const lines = chunk.map((g) => `${g.id}\t${String(g.group_name || '').replace(/\s+/g, ' ').trim()}`).join('\n');
    const prompt = `You normalize trucking driver group names into structured fields.\n`
      + `For each line below (format: "<id>\\t<group_name>"), extract:\n`
      + `- unit_number: the truck/unit number (digits only, no leading "UNIT #"); null if none.\n`
      + `- first_name: the primary driver's first name; null if unclear.\n`
      + `- last_name: the primary driver's last/family name (may be empty); null if none.\n`
      + `- secondary_first_name: only for team drivers / slash-separated second names; else null.\n`
      + `- secondary_last_name: only for team drivers / slash-separated second names; else null.\n`
      + `- driver_type: "company_driver" if the name marks them as a company driver `
      + `(e.g. it contains "COMPANY DRIVER" or "COMPANY DRIVERS"); otherwise "owner".\n`
      + `Company prefixes like "WENZE" are NOT part of the driver's name. If two names are joined `
      + `with "/" then split them into primary and secondary driver fields.\n`
      + `IMPORTANT: the words "ACTIVE" and "INACTIVE" in a group name are status markers, NOT part of `
      + `the driver's name — never include them in first_name or last_name.\n\n`
      + `Lines:\n${lines}\n\n`
      + `Respond with JSON only: {"drivers":[{"group_id":<id>,"unit_number":"","first_name":"","last_name":"","secondary_first_name":"","secondary_last_name":"","driver_type":"owner|company_driver"}]}`;

    const { parsed } = await callGeminiJson({
      userText: prompt,
      maxOutputTokens: 2000,
      validateParsed: (p) => Array.isArray(p?.drivers),
    });
    for (const row of parsed.drivers || []) {
      const gid = Number(row.group_id);
      if (!Number.isInteger(gid)) continue;
      out.set(gid, {
        unit_number: cleanStr(row.unit_number),
        first_name: cleanStr(row.first_name),
        last_name: cleanStr(row.last_name),
        secondary_first_name: cleanStr(row.secondary_first_name),
        secondary_last_name: cleanStr(row.secondary_last_name),
        driver_type: normalizeType(row.driver_type),
      });
    }
  }
  return out;
}

module.exports = { parseGroups, normalizeType };
