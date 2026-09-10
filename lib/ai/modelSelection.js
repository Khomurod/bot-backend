/**
 * Which discovered models Wenze should actually ask, in what order. PURE.
 *
 * A provider's `/models` listing is not a list of chat models. It carries
 * embeddings, speech-to-text, text-to-speech, moderation classifiers and image
 * generators beside the models that can answer a prompt — and every one of
 * those, placed at the head of a chain, fails every call with a request error
 * before the first real model is tried. So the first job here is REFUSING.
 *
 * The second is ORDER. The router tries a chain top to bottom, so the head
 * should be the strongest general model and the chain should always end in a
 * fast, small one — the fallback that answers when the big ones are busy. That
 * shape is what `groqClient`'s hand-maintained chains always had; this derives
 * it from what the provider says exists today instead of from a constant that
 * goes stale the week a model is retired.
 *
 * Nothing here is clever about quality. A short ranked table of model FAMILIES
 * Wenze has run well on, a penalty for previews, and a size hint. It only has
 * to be better than an administrator typing names from memory, and to be
 * predictable enough that an operator can read the result and see why.
 *
 * FREE STATUS IS REPORTED ONLY WHEN IT IS KNOWABLE. OpenRouter publishes
 * per-model pricing, so "free" there is a fact. Groq, Cerebras and NVIDIA
 * document a free tier across their catalogue. Gemini's free tier covers the
 * Flash models. Everyone else is `unknown`, and `unknown` is the honest answer
 * — a chain that guessed "free" would be exactly the kind of fabricated fact
 * this whole system exists to remove.
 */

const MAX_CHAIN = 5;

/** Names that mean "cannot answer a chat prompt", whatever the provider. */
const NOT_CHAT = [
  /whisper/i, /\btts\b/i, /speech/i, /audio/i, /transcri/i,
  /embed/i, /rerank/i, /moderation/i, /guard/i, /safeguard/i, /classifier/i,
  /dall-e/i, /diffusion/i, /imagen/i, /\bflux\b/i, /\bsora\b/i, /\bveo\b/i,
  /image-generation/i, /image-preview/i, /\bclip\b/i, /\bocr\b/i,
  /robotics/i, /computer-use/i, /deep-research/i, /\blive\b/i, /native-audio/i,
  /\baqa\b/i, /-base$/i, /compound/i,
];

/** A small, fast model — the shape every chain should end in. */
const SMALL = [/\b8b\b/i, /-8b/i, /\bsmall\b/i, /\bmini\b/i, /\blite\b/i, /flash-lite/i, /haiku/i, /\b7b\b/i, /-7b/i];

/**
 * Families Wenze has run well on, strongest first. Matched against the id;
 * the first hit wins. Unknown models score 40 and are ordered by size hint.
 */
const FAMILY_RANK = [
  [/llama-3\.3-70b/i, 100], [/llama-3\.1-70b/i, 98],
  [/gemini-2\.5-flash(?!-lite)/i, 100], [/gemini-3-flash(?!-lite)/i, 98], [/gemini-3\.1-flash(?!-lite)/i, 96],
  [/gpt-oss-120b/i, 95], [/llama-4-maverick/i, 90], [/llama-4-scout/i, 88],
  [/qwen-?3-235b/i, 86], [/kimi-k2/i, 84], [/gpt-oss-20b/i, 82], [/qwen-?3-32b/i, 80],
  [/deepseek-(chat|v3|r1)/i, 78], [/mistral-(large|medium)/i, 76], [/gemma-[23]-27b/i, 74],
  [/llama-3\.3-70b-instruct/i, 100], [/llama-3\.1-405b/i, 92],
  [/gemini-2\.0-flash(?!-lite)/i, 70], [/flash-lite/i, 66], [/llama-3\.1-8b/i, 70],
  [/gemini-.*-pro/i, 60], [/gpt-4o-mini/i, 72], [/gpt-4o/i, 74],
];

function idOf(raw, adapter) {
  if (adapter === 'gemini') return String(raw?.name || raw?.id || '').replace(/^models\//, '');
  return String(raw?.id || raw?.name || '');
}

/**
 * One shape for every provider's listing entry. Keeps only what selection and
 * the admin need — a listing can carry kilobytes per model, and it is stored.
 */
function normaliseModel(raw, adapter, providerKey = null) {
  const id = idOf(raw, adapter);
  const arch = raw?.architecture || {};
  return {
    id,
    displayName: raw?.displayName || raw?.name || id,
    contextLength: raw?.context_length ?? raw?.context_window ?? raw?.inputTokenLimit ?? null,
    methods: Array.isArray(raw?.supportedGenerationMethods) ? raw.supportedGenerationMethods : null,
    inputModalities: Array.isArray(arch.input_modalities) ? arch.input_modalities : null,
    outputModalities: Array.isArray(arch.output_modalities) ? arch.output_modalities : null,
    pricing: raw?.pricing && typeof raw.pricing === 'object'
      ? { prompt: raw.pricing.prompt ?? null, completion: raw.pricing.completion ?? null }
      : null,
    ownedBy: raw?.owned_by ?? null,
    providerKey,
  };
}

function isChatCapable(model) {
  if (!model?.id) return false;
  if (NOT_CHAT.some((re) => re.test(model.id))) return false;
  // Gemini says outright what a model can do; believe it over the name.
  if (model.methods) return model.methods.includes('generateContent');
  if (model.outputModalities && !model.outputModalities.includes('text')) return false;
  return true;
}

function isZeroPrice(value) {
  if (value == null) return false;
  const n = Number(value);
  return Number.isFinite(n) && n === 0;
}

/** 'free' | 'paid' | 'unknown' — and unknown means unknown. */
function freeStatusOf(model, providerKey) {
  const key = String(providerKey || model?.providerKey || '').toLowerCase();
  if (key === 'openrouter') {
    if (/:free$/i.test(model.id)) return 'free';
    if (model.pricing) {
      return isZeroPrice(model.pricing.prompt) && isZeroPrice(model.pricing.completion) ? 'free' : 'paid';
    }
    return 'unknown';
  }
  if (key === 'groq' || key === 'cerebras' || key === 'nvidia') return 'free';
  if (key === 'gemini') return /flash/i.test(model.id) ? 'free' : 'unknown';
  return 'unknown';
}

function isSmall(id) {
  return SMALL.some((re) => re.test(id));
}

function sizeHint(id) {
  const m = String(id).match(/(\d+(?:\.\d+)?)\s*b\b/i);
  return m ? Math.min(Number(m[1]) / 10, 20) : 0;
}

function scoreModel(model, providerKey) {
  const id = model.id;
  const family = FAMILY_RANK.find(([re]) => re.test(id));
  let score = family ? family[1] : 40 + sizeHint(id);
  if (/instruct|chat|-it$/i.test(id)) score += 3;
  if (/preview|-exp\b|experimental|beta|alpha/i.test(id)) score -= 15;
  if (freeStatusOf(model, providerKey) === 'free') score += 2;
  return score;
}

/**
 * The chain to configure: strongest first, always ending in something small.
 *
 * The small-model slot is guaranteed rather than left to the score, because a
 * chain of five large models has no answer for "everything big is busy" — and
 * that is the moment a fallback earns its place.
 */
function selectModelChain(models, { providerKey = null, freeOnly = false, max = MAX_CHAIN } = {}) {
  let usable = (models || []).filter(isChatCapable);
  if (freeOnly) usable = usable.filter((m) => freeStatusOf(m, providerKey) === 'free');
  const ranked = [...usable].sort((a, b) => {
    const d = scoreModel(b, providerKey) - scoreModel(a, providerKey);
    return d !== 0 ? d : a.id.localeCompare(b.id);
  });
  if (ranked.length <= max) return ranked.map((m) => m.id);

  const head = ranked.slice(0, max - 1).map((m) => m.id);
  if (head.some(isSmall)) return [...head, ranked[max - 1].id];
  const small = ranked.find((m) => isSmall(m.id) && !head.includes(m.id));
  return [...head, (small || ranked[max - 1]).id];
}

/**
 * What a fresh listing says about the chain an operator has.
 *
 * `retired` are configured models the provider no longer lists — the thing the
 * maintenance job acts on. `kept` preserves the operator's ORDER, because that
 * order is a decision. `added` is what Wenze would pick from what is new.
 *
 * AN EMPTY LISTING RETIRES NOTHING. A discovery that failed or returned nothing
 * is not evidence that every model vanished; stripping a working chain on it
 * would turn one bad fetch into an outage. `unverified: true` says so.
 */
function reconcileChain(currentChain, discovered, { providerKey = null, freeOnly = false } = {}) {
  const current = (currentChain || []).map((m) => String(m || '').trim()).filter(Boolean);
  if (!discovered || discovered.length === 0) {
    return { kept: current, retired: [], added: [], chain: current, unverified: true };
  }
  const ids = new Set(discovered.map((m) => m.id));
  const kept = current.filter((m) => ids.has(m));
  const retired = current.filter((m) => !ids.has(m));
  const proposed = selectModelChain(discovered, { providerKey, freeOnly });
  const added = proposed.filter((m) => !kept.includes(m));
  const chain = kept.length ? [...kept, ...added].slice(0, MAX_CHAIN) : proposed;
  return { kept, retired, added, chain, unverified: false };
}

module.exports = {
  MAX_CHAIN, normaliseModel, isChatCapable, freeStatusOf, selectModelChain, reconcileChain,
  scoreModel, isSmall,
};
