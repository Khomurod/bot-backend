/**
 * Classify driver Telegram group titles as operationally active or inactive.
 */
const { callGroqWithFallback, isAuthOrConfigError } = require('./groqClient');
const { callGeminiJson, GEMINI_API_KEY } = require('./geminiClient');

const SYSTEM_TEXT =
  'You classify trucking company Telegram driver group titles. '
  + 'Return JSON only: a single array of objects. No markdown fences or prose. '
  + 'If unsure, set active to false.';

function buildClassificationPrompt(batch) {
  const payload = batch.map((g) => ({ id: g.id, group_name: g.group_name }));
  return (
    'For each driver group below, decide if the driver/unit is OPERATIONALLY ACTIVE '
    + '(still an active driver at the company) based only on the group_name text.\n\n'
    + 'Rules:\n'
    + '- If the title contains INACTIVE (especially at the end or as a status marker), active=false.\n'
    + '- Titles with only (COMPANY DRIVER) or company markers without INACTIVE are usually active=true.\n'
    + '- OFFLINE, TERMINATED, FIRED, QUIT, ARCHIVED imply active=false.\n'
    + '- When ambiguous, active=false.\n\n'
    + 'Return JSON array: [{"id":number,"active":boolean,"reason":string}, ...]\n'
    + 'Use exactly the ids provided.\n\n'
    + `Groups:\n${JSON.stringify(payload)}`
  );
}

function extractJsonArray(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : raw;
  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseClassificationResponse(text, batch) {
  const allowed = new Map(batch.map((g) => [g.id, g]));
  const arr = extractJsonArray(text);
  if (!arr) return [];

  const out = [];
  for (const row of arr) {
    const id = Number(row?.id);
    if (!allowed.has(id)) continue;
    out.push({
      id,
      active: row.active === true,
      reason: typeof row.reason === 'string' ? row.reason.slice(0, 200) : '',
    });
  }
  return out;
}

/** Heuristic fallback when AI is unavailable (title contains INACTIVE etc.). */
function classifyGroupHeuristic(group) {
  const name = String(group.group_name || '').toUpperCase();
  const inactivePatterns = [
    /\bINACTIVE\b/,
    /\bOFFLINE\b/,
    /\bTERMINATED\b/,
    /\bFIRED\b/,
    /\bQUIT\b/,
    /\bARCHIVED\b/,
  ];
  const active = !inactivePatterns.some((re) => re.test(name));
  return { id: group.id, active, reason: 'heuristic' };
}

async function classifyBatchViaGroq(batch) {
  const prompt = buildClassificationPrompt(batch);
  const { text, model } = await callGroqWithFallback(prompt, {
    systemText: SYSTEM_TEXT,
    temperature: 0.1,
    maxTokens: Math.min(8000, 200 + batch.length * 80),
    models: [
      process.env.GROUP_STATUS_AI_GROQ_MODEL || 'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
    ],
  });
  const results = parseClassificationResponse(text, batch);
  return { results, model, provider: 'groq' };
}

async function classifyBatchViaGemini(batch) {
  const prompt = buildClassificationPrompt(batch);
  const { text, model } = await callGeminiJson({
    systemText: SYSTEM_TEXT,
    userText: prompt,
    maxOutputTokens: Math.min(8000, 200 + batch.length * 80),
    generationConfig: { temperature: 0.1 },
  });
  const results = parseClassificationResponse(text, batch);
  return { results, model, provider: 'gemini' };
}

async function classifyBatch(batch) {
  try {
    const groq = await classifyBatchViaGroq(batch);
    if (groq.results.length > 0) return groq;
    if (GEMINI_API_KEY) {
      return await classifyBatchViaGemini(batch);
    }
    return groq;
  } catch (groqErr) {
    if (!GEMINI_API_KEY || isAuthOrConfigError(groqErr.message)) {
      throw groqErr;
    }
    console.warn('[GROUP-STATUS-AI] Groq failed, trying Gemini:', groqErr.message.slice(0, 200));
    return classifyBatchViaGemini(batch);
  }
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Classify all groups; returns Map of id -> { active, reason, provider }.
 */
async function classifyDriverGroups(groups, batchSize = 25) {
  const byId = new Map();
  const chunks = chunkArray(groups, batchSize);

  for (const batch of chunks) {
    let applied = false;
    try {
      const { results, provider, model } = await classifyBatch(batch);
      if (results.length > 0) {
        for (const r of results) {
          byId.set(r.id, { active: r.active, reason: r.reason, provider, model });
        }
        applied = true;
      }
    } catch (err) {
      console.error('[GROUP-STATUS-AI] Batch classify failed:', err.message);
    }

    if (!applied) {
      for (const g of batch) {
        const h = classifyGroupHeuristic(g);
        byId.set(h.id, { active: h.active, reason: h.reason, provider: 'heuristic' });
      }
    }
  }

  return byId;
}

module.exports = {
  buildClassificationPrompt,
  parseClassificationResponse,
  classifyGroupHeuristic,
  classifyDriverGroups,
  extractJsonArray,
};
