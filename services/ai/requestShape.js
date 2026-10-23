/**
 * A prompt in the shape each wire format wants. PURE — no I/O, no adapter.
 *
 * Moved out of `router.js` when Claude became the third adapter (October 2026)
 * so the router stays the sequencing and nothing else. `anthropic` and
 * `openai_chat` both take OpenAI-shaped `messages` (the Anthropic adapter
 * splits out the system text itself); only Gemini needs a different shape.
 */
/**
 * OpenAI-shaped `messages` → Gemini's `contents` + `systemInstruction`.
 *
 * NOT a nicety. The rate-confirmation readers this was written for
 * (`requestPinnedContextFromGroq`, `requestDispatchTemplateFromGroq`, both gone
 * now with the Dispatch Center and the pinned-load reading) passed the Groq
 * fallback an EMPTY prompt and put the entire document in `messages`. Without
 * this, the moment the roster reached a Gemini provider it would send
 * `[{ parts: [{ text: '' }] }]` — an EMPTY prompt — and a model asked nothing at
 * all still returns well-formed JSON. A caller that validates the SHAPE of the
 * answer, not its truth, would pass a guessed address through as an extracted
 * fact. A confident wrong answer is worse than a failure, and this is how one
 * gets made — so any caller that sends `messages` keeps this protection.
 */
function geminiTurnsFromMessages(messages, extraParts) {
  const systemParts = [];
  const turns = [];
  for (const m of messages) {
    const text = String(m?.content ?? '');
    if (m?.role === 'system') {
      systemParts.push({ text });
      continue;
    }
    turns.push({ role: m?.role === 'assistant' ? 'model' : 'user', parts: [{ text }] });
  }
  const extras = extraParts || [];
  if (extras.length) {
    if (turns.length) turns[turns.length - 1].parts.push(...extras);
    else turns.push({ role: 'user', parts: [{ text: '' }, ...extras] });
  }
  return { systemParts, turns };
}

/**
 * Gemini-shaped extra parts (`{text}` and `{inline_data: {mime_type, data}}`)
 * as OpenAI multipart content: text pieces and `image_url` data URIs. Both the
 * OpenAI-compatible providers and the Claude adapter take this shape (the
 * Claude adapter turns `image_url` into its own image block).
 */
function openAiParts(userText, extraParts) {
  const parts = [{ type: 'text', text: userText || '' }];
  for (const part of extraParts || []) {
    const inline = part?.inline_data || part?.inlineData;
    if (inline?.data) {
      const mime = inline.mime_type || inline.mimeType || 'image/jpeg';
      parts.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${inline.data}` } });
    } else if (typeof part?.text === 'string') {
      parts.push({ type: 'text', text: part.text });
    }
  }
  return parts;
}

/** Prompt → the shape this provider's wire format wants. */
function buildRequest(provider, {
  systemText, userText, messages, contents, extraParts, generationConfig, systemInstruction,
}) {
  if (provider.adapter === 'gemini') {
    // A caller that built its own Gemini-shaped instruction keeps it; a caller
    // that passed plain text or OpenAI messages gets one built here.
    let builtContents = contents;
    let builtSystem = systemInstruction
      || (systemText ? { parts: [{ text: systemText }] } : null);

    if (!builtContents && Array.isArray(messages) && messages.length) {
      const { systemParts, turns } = geminiTurnsFromMessages(messages, extraParts);
      builtContents = turns.length ? turns : [{ role: 'user', parts: [{ text: '' }] }];
      if (!builtSystem && systemParts.length) builtSystem = { parts: systemParts };
    } else if (!builtContents) {
      builtContents = [{ role: 'user', parts: [{ text: userText || '' }, ...(extraParts || [])] }];
    }

    return {
      contents: builtContents,
      systemInstruction: builtSystem,
      generationConfig: generationConfig || {},
    };
  }
  const extras = extraParts && extraParts.length ? extraParts : null;
  if (messages && extras) {
    // Pictures ride on the last user turn, as geminiTurnsFromMessages does.
    const copy = messages.map((m) => ({ ...m }));
    const last = [...copy].reverse().find((m) => m.role !== 'system' && m.role !== 'assistant');
    if (last) last.content = openAiParts(typeof last.content === 'string' ? last.content : '', extras);
    else copy.push({ role: 'user', content: openAiParts('', extras) });
    return { messages: copy };
  }
  const built = messages || [
    ...(systemText ? [{ role: 'system', content: systemText }] : []),
    { role: 'user', content: extras ? openAiParts(userText, extras) : (userText || '') },
  ];
  return { messages: built };
}

module.exports = { buildRequest, geminiTurnsFromMessages, openAiParts };
