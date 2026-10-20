'use strict';

/**
 * What a model's reading of a conversation may become: a proposal to move a
 * deal, or nothing. Pure.
 *
 * THE MODEL READS THE LANGUAGE ("CLH sent", "CLEAN", "we cah hire him"); THE
 * RULES HERE DECIDE WHAT MAY BE PROPOSED. A reading is dropped — and nothing
 * is posted — unless:
 *
 *   1. the stage is one of the pipeline's stages, by its Bitrix id;
 *   2. it is not where the deal already is;
 *   3. it is FORWARD of where the deal is, or a failure stage ("not approved"
 *      may end a candidate from anywhere). A conversation moves a candidate
 *      on; "can we check it once again" is not a reason to send a deal back,
 *      and a person can always move one back by hand in Bitrix;
 *   4. the quoted evidence is words somebody actually wrote in this
 *      conversation (not the model's summary of them);
 *   5. every part of the driver's name, when one is given, is in the
 *      conversation — it is shown on the proposal and may be searched by.
 *
 * Even then it is only a PROPOSAL. A person presses the button.
 */

/** Bitrix stage rows (crm.status.list) → [{id, name, sort, semantics}] in pipeline order. */
function normaliseStages(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((r) => ({
      id: String(r.STATUS_ID ?? r.id ?? '').trim(),
      name: String(r.NAME ?? r.name ?? '').trim(),
      sort: Number(r.SORT ?? r.sort) || 0,
      semantics: String(r.EXTRA?.SEMANTICS ?? r.SEMANTICS ?? r.semantics ?? '').trim().toUpperCase(),
    }))
    .filter((s) => s.id && s.name)
    .sort((a, b) => a.sort - b.sort);
}

/** The same stage in another pipeline: Bitrix ids differ per pipeline, names are what people chose. */
function stageByName(stages, name) {
  const want = String(name || '').trim().toLowerCase();
  return stages.find((s) => s.name.toLowerCase() === want) || null;
}

function collapse(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Words of a name, as compared: letters only, two or more of them. */
function nameParts(name) {
  return collapse(name).split(/[^a-zÀ-ɏ'-]+/).filter((w) => w.length >= 2);
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Is this whole word in the text? ("al" is not in "approval"). */
function hasWord(text, word) {
  return new RegExp(`(^|[^a-z\u00c0-\u024f])${escapeRegExp(word)}($|[^a-z\u00c0-\u024f])`).test(text);
}

function nameIsInConversation(name, searchable) {
  const parts = nameParts(name);
  return parts.length > 0 && parts.every((p) => hasWord(searchable, p));
}

/** May the deal go from `current` to `target`? (rule 3) */
function isForwardMove(stages, currentStageId, target) {
  if (!currentStageId) return true;
  const current = stages.find((s) => s.id === currentStageId);
  // A closed deal (won or lost) is reopened by a person, never by a proposal.
  if (current && (current.semantics === 'S' || current.semantics === 'F')) return false;
  if (target.semantics === 'F' || !current) return true;
  return target.sort > current.sort;
}

/**
 * @param {object|null} parsed  the model's JSON
 * @param {object} ctx
 * @param {{id,name,sort,semantics}[]} ctx.stages
 * @param {string|null} ctx.currentStageId
 * @param {string} ctx.searchable  conversation/searchableText
 * @returns {{move: false, reason: string} |
 *   {move: true, stage: object, driverName: string|null, evidence: string}}
 */
function verifyStageAnswer(parsed, { stages, currentStageId = null, searchable }) {
  if (!parsed || typeof parsed !== 'object') return { move: false, reason: 'no_answer' };
  if (parsed.move !== true) return { move: false, reason: 'no_change' };

  const stage = stages.find((s) => s.id === String(parsed.stage_id ?? '').trim());
  if (!stage) return { move: false, reason: 'unknown_stage' };
  if (stage.id === currentStageId) return { move: false, reason: 'already_there' };
  if (!isForwardMove(stages, currentStageId, stage)) return { move: false, reason: 'backwards' };

  const evidence = String(parsed.evidence ?? '').trim();
  if (evidence.length < 2 || !searchable.includes(collapse(evidence))) {
    return { move: false, reason: 'evidence_not_in_conversation' };
  }

  const rawName = String(parsed.driver_name ?? '').replace(/\s+/g, ' ').trim();
  const driverName = rawName && nameIsInConversation(rawName, searchable) ? rawName : null;
  if (rawName && !driverName) return { move: false, reason: 'name_not_in_conversation' };

  return { move: true, stage, driverName, evidence };
}

module.exports = {
  normaliseStages,
  stageByName,
  nameParts,
  hasWord,
  isForwardMove,
  verifyStageAnswer,
};
