'use strict';

/**
 * What the owner's reply to a Board ↔ Bitrix question means. PURE, no model.
 *
 *   done   "done", "fixed", "сделал", "готово", "исправил", "поправил" … —
 *          they changed Bitrix; check again now
 *   skip   "skip", "later", "пропусти", "позже" … — come back to it tomorrow
 *   unclear anything else; the question stands and the reply says what to type
 *
 * A NEGATION ANYWHERE MAKES IT UNCLEAR, never "done": "not done", "haven't
 * fixed it yet", "isn't done", "не сделал", "не всё готово", "нет". Reading one
 * of those as "done" would re-read Bitrix and answer "still different" to a
 * person who just said it is not fixed. Unclear costs one line saying what to
 * type.
 */

const DONE = /(^|[^\p{L}])(done|fixed|ready|updated|corrected|changed|сделал[аи]?|сделано|готово|исправил[аи]?|исправлено|поправил[аи]?|поправлено|обновил[аи]?|изменил[аи]?)(?=$|[^\p{L}])/iu;
const SKIP = /(^|[^\p{L}])(skip|later|next|пропусти(ть)?|позже|потом|дальше)(?=$|[^\p{L}])/iu;
const NEGATED = /n['’]t(?=$|[^\p{L}])|(^|[^\p{L}])(not|no|never|не|нет|ни)(?=$|[^\p{L}])/iu;

function readReply(text) {
  const words = String(text || '').trim();
  if (!words) return 'unclear';
  if (NEGATED.test(words)) return 'unclear';
  if (DONE.test(words)) return 'done';
  if (SKIP.test(words)) return 'skip';
  return 'unclear';
}

module.exports = { readReply };
