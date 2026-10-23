'use strict';

/**
 * Asking a model where a candidate's conversation has got to.
 *
 * The model is here for the LANGUAGE — "CLH sent", "CLEAN", "we cah hire him",
 * "driver was at fault, we cannot hire him" — and for matching it to the
 * stage names this company chose in Bitrix. What it answers is then cut down
 * by lib/hiringStages/proposal.js (a real stage, forward only, evidence that
 * somebody actually wrote), and even a verified answer is only a proposal a
 * person confirms.
 *
 * THE TEXT IS REDACTED FIRST (lib/hiringStages/redact.js): no SSN, birth date,
 * licence number, phone or other long number leaves. No photo is sent — a
 * stage is read from words, so any provider can answer, vision or not.
 *
 * The conversation is fenced as untrusted data: anybody in the group can
 * write "ignore the above" into it.
 *
 * `AiUnavailableError` is re-thrown so the queue tries again later.
 */

const { AiUnavailableError, runCapability } = require('../ai/router');

const CAPABILITY = 'hiring_stage_reading';

const SYSTEM = [
  'You follow a trucking company\'s recruiting group chat.',
  'A recruiter posted a driver candidate; Safety and the recruiters then talk about that candidate',
  'in replies: Clearinghouse (CLH) requests, MVR and PSP reports, approvals, drug tests, arrival at the office.',
  'You are given that conversation (oldest first), the stages of the candidate\'s deal in the company\'s',
  'CRM pipeline (in pipeline order), and the stage the deal is in now, when known.',
  '',
  'Decide whether the conversation shows the candidate has ALREADY reached a later stage than the',
  'current one, and which stage. Match by meaning, for example:',
  '- Safety sent the Clearinghouse request ("CLH sent") → the clearinghouse check stage.',
  '- Clearinghouse came back clean and MVR / PSP are being checked → the MVR / PSP check stage.',
  '- Safety approved / "we can hire" / "good to go" → the stage for an approved, ready candidate.',
  '- Safety refused / "not approved" / "cannot hire" → a failure (lost) stage, if the pipeline has one.',
  'Rules:',
  '- Only something that HAS happened moves a stage. Questions, requests, plans and "on it" do not.',
  '- Only Safety approves or refuses. A recruiter asking "can we hire him?" decides nothing.',
  '- Choose the furthest stage the conversation clearly shows. When unsure, "move": false.',
  '- stage_id: exactly one of the ids listed.',
  '- evidence: copy the exact words of ONE message that show it, as written.',
  '- driver_name: the candidate\'s name exactly as written in the post, or null.',
  '',
  'Answer with JSON only:',
  '{"move": true, "stage_id": "...", "driver_name": "First Last", "evidence": "exact words"}',
  'or {"move": false, "driver_name": "First Last or null"}',
].join('\n');

function fence(tag, text) {
  return `<${tag}>\n${String(text || '').replace(new RegExp(`</?${tag}>`, 'gi'), '')}\n</${tag}>`;
}

function buildPrompt({ transcript, stages, currentStage }) {
  const list = stages.map((s) => {
    const kind = s.semantics === 'S' ? ' (won / final)' : s.semantics === 'F' ? ' (lost / failure)' : '';
    return `- ${s.id}: ${s.name}${kind}`;
  }).join('\n');
  return [
    `Pipeline stages, in order:\n${list}`,
    currentStage
      ? `The deal is now at: ${currentStage.id} (${currentStage.name}).`
      : 'No deal has been found yet, so the current stage is unknown.',
    fence('conversation', transcript),
  ].join('\n\n');
}

function validateShape(_text, parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { message: 'not a JSON object' };
  if (typeof parsed.move !== 'boolean') return { message: '"move" must be true or false' };
  if (parsed.move && typeof parsed.stage_id !== 'string') return { message: '"stage_id" is required when moving' };
  return true;
}

/**
 * @returns {Promise<{parsed: object|null, provider: string|null, model: string|null}>}
 * @throws {AiUnavailableError} when no model could be asked
 */
async function readConversationStage({ transcript, stages, currentStage = null }, deps = {}) {
  const run = deps.runCapability || runCapability;
  const answer = await run({
    capability: CAPABILITY,
    systemText: SYSTEM,
    userText: buildPrompt({ transcript, stages, currentStage }),
    expects: 'json',
    validate: validateShape,
  });
  // Not sure even after Claude (services/ai/escalation.js): propose nothing.
  const parsed = answer?.uncertain ? { move: false } : (answer?.parsed ?? null);
  return { parsed, provider: answer?.provider ?? null, model: answer?.model ?? null };
}

module.exports = {
  CAPABILITY,
  SYSTEM,
  buildPrompt,
  validateShape,
  readConversationStage,
  AiUnavailableError,
};
