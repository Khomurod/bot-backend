/**
 * Telegram delivery records — the ordered list of messages one route delivery is
 * made of, so every part can later be edited IN PLACE.
 *
 * Entirely pure: reads/writes plain objects only. Understands both the current
 * `driver_group_messages` JSONB list and the legacy scalar
 * `driver_group_message_id` + `driver_group_message_via` shape.
 */

/**
 * PURE. Build the ordered list of Telegram messages a delivery is made of, from
 * the send outcome. `[{ message_id, kind:'photo'|'text' }]` — the record used to
 * edit every part in place later. Ids that never came back are dropped.
 */
function buildDeliveryMessageList({ via, photoMessageId = null, textMessageId = null }) {
  const out = [];
  if ((via === 'photo' || via === 'photo+text') && Number.isFinite(Number(photoMessageId))) {
    out.push({ message_id: Number(photoMessageId), kind: 'photo' });
  }
  if ((via === 'text' || via === 'photo+text') && Number.isFinite(Number(textMessageId))) {
    out.push({ message_id: Number(textMessageId), kind: 'text' });
  }
  return out;
}

/**
 * PURE. Read the Telegram message list for an assignment. Prefers the
 * authoritative `driver_group_messages` (JSONB, restart-safe). Falls back to
 * reconstructing from the legacy scalar `driver_group_message_id` +
 * `driver_group_message_via` for rows created before message-list tracking —
 * NOTE: a legacy 'photo+text' row only stored ONE id (the text message), so its
 * photo message id is unknown and cannot be edited (reported as a limitation).
 *
 * @returns {{ messages: Array<{message_id:number, kind:string}>, legacy:boolean }}
 */
function parseDeliveryMessages(assignment) {
  let list = assignment?.driver_group_messages;
  if (typeof list === 'string' && list.trim()) {
    try { list = JSON.parse(list); } catch (_) { list = null; }
  }
  if (Array.isArray(list)) {
    const messages = list
      .map((m) => ({
        message_id: Number(m?.message_id ?? m?.messageId),
        kind: m?.kind === 'photo' ? 'photo' : 'text',
      }))
      .filter((m) => Number.isFinite(m.message_id));
    if (messages.length) return { messages, legacy: false };
  }
  // NOTE: check null BEFORE Number() — Number(null) === 0 would masquerade as a
  // real message id 0 for a never-sent route.
  const rawId = assignment?.driver_group_message_id;
  if (rawId == null) return { messages: [], legacy: true };
  const id = Number(rawId);
  if (!Number.isFinite(id)) return { messages: [], legacy: true };
  const via = assignment?.driver_group_message_via || 'text';
  if (via === 'photo') return { messages: [{ message_id: id, kind: 'photo' }], legacy: true };
  // Legacy 'photo+text' / 'text': the one stored id is the TEXT message.
  return { messages: [{ message_id: id, kind: 'text' }], legacy: true };
}

module.exports = {
  buildDeliveryMessageList,
  parseDeliveryMessages,
};
