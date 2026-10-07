/**
 * What an owner's reply MEANS — deterministically, with no model involved.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE: a reply may only choose an action the
 * question already offered. Not "an action that sounds right", not "an action
 * the words imply" — one of the keys in the question's `offeredActions`. Free
 * text arrives from a group chat; if the text could name the action, then the
 * text decides what happens to the fleet, and a stray "yes, and also deactivate
 * everything" becomes a command.
 *
 * So the shape is: read the sentence, map it to one of a CLOSED set of
 * intents, then check that intent against what was offered. Anything that does
 * not map, or maps to something not offered, is `unclear` — which is a real
 * answer, not a failure. Wenze asks again or leaves the finding open.
 *
 * PURE. No I/O, no clock, no randomness. Reading the signature is how a
 * reviewer confirms no model can reach this decision: there is no parameter
 * through which one could arrive, and a test asserts the parameter names.
 */

/** Every intent this parser can return. Nothing outside this list exists. */
const INTENTS = Object.freeze([
  'approve', 'alternative', 'dismiss', 'snooze', 'engineering_request', 'unclear',
]);

const APPROVE = [
  /^\s*(yes|yep|yeah|ya|ok|okay|okey|sure|correct|right|confirm(ed)?|approve[d]?|apply|do it|go ahead|proceed|fix it|da|ha)\b/i,
  /\b(yes|approve|apply it|go ahead|do it|that'?s right|that is right|confirmed)\b/i,
];

const DISMISS = [
  /^\s*(no|nope|nah|not?|don'?t|do not|ignore|skip|dismiss|leave it|it'?s fine|its fine|that'?s fine|yo'?q|yoq)\b/i,
  /\b(not a problem|no problem here|leave it alone|ignore this|dismiss|that'?s expected|that is expected|it'?s correct as is)\b/i,
];

const ENGINEERING = [
  /\b(bug|broken|shouldn'?t (even )?(be )?(ask|happen)|wrong question|why (are|is) (you|wenze) asking|fix the (code|app|system)|this is a mistake in|build|add a feature|feature request)\b/i,
];

const SNOOZE_WORDS = /\b(later|tomorrow|next week|remind me|not now|ask me later|keyin|kutib tur)\b/i;
const SNOOZE_IN = /\bin\s+(\d{1,3})\s*(hour|hours|hr|hrs|day|days|week|weeks)\b/i;
const REMEMBER = /\b(always|every time|from now on|don'?t ask (me )?again|do not ask (me )?again|remember (this|that))\b/i;

/**
 * THE WORDS FOR A CHOICE QUESTION. "Is he still working?" is not a yes/no about
 * a fix — the answer is a VALUE, and the owner says it the way people do:
 * "working", "he quit", "уволился", "ishlayapti". Each offered choice names its
 * vocabulary; nothing here can name an action.
 *
 * ORDER MATTERS: the negations come first, because "not working" contains
 * "working" and "не водитель" contains "водитель".
 */
const VOCAB = Object.freeze([
  ['not_working', /\b(not working|no longer (working|with us|here|driving)|doesn'?t work|does not work|quit|left us|fired|terminated|inactive|resigned|let go)\b|не работает|уволил|уволен|ушёл|ушел|не активен|ishlamaydi|ketdi|bo'?shatildi/i],
  ['not_driver_chat', /\b(not a driver|no driver|not drivers?'? ?(chat|group)?|office|admin|company chat|leads)\b|не водител|офис|админ/i],
  ['working', /\b(working|active|still (here|with us|driving)|on the road|driving)\b|работает|активен|ishlayapti|ishlaydi/i],
  ['driver_chat', /\b(driver'?s? (chat|group)|a driver|real driver)\b|водител/i],
]);

/** "later" is a week; "tomorrow" a day. Both chosen to be visibly not-forever. */
const SNOOZE_DEFAULT_HOURS = 24 * 7;
const TOMORROW_HOURS = 24;

function snoozeHoursFrom(text) {
  const m = SNOOZE_IN.exec(text);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    if (!Number.isFinite(n) || n <= 0) return SNOOZE_DEFAULT_HOURS;
    if (unit.startsWith('hour') || unit.startsWith('hr')) return Math.min(n, 720);
    if (unit.startsWith('day')) return Math.min(n * 24, 720);
    return Math.min(n * 24 * 7, 720);
  }
  if (/\btomorrow\b/i.test(text)) return TOMORROW_HOURS;
  return SNOOZE_DEFAULT_HOURS;
}

/**
 * The words after a refusal, as the dismissal's reason.
 *
 * A bare "no" carries no reason, and the caller asks once for one — a finding
 * dismissed with no reason recorded is a decision nobody can review later.
 */
function reasonFrom(text) {
  const trimmed = String(text).trim();
  const stripped = trimmed
    .replace(/^\s*(no|nope|nah|don'?t|do not|dismiss|ignore|skip)\b[\s,.:;–-]*/i, '')
    .replace(/^(because|since|it'?s|its|that'?s)\b\s*/i, '')
    .trim();
  return stripped.length >= 3 ? stripped.slice(0, 500) : null;
}

function matchesAny(patterns, text) {
  return patterns.some((re) => re.test(text));
}

/**
 * A choice question's answer, or null when the words name none of its choices.
 * First the choices' own words, then yes/no — which a choice claims with
 * `answers`, because "yes" means "working" to "is he working?" and means
 * "driver chat" to "is this a driver's chat?".
 */
const UNSURE = /\b(don'?t know|do not know|not sure|no idea|who is (this|that|he|she)|which (driver|one)|who\?)|не знаю|кто это|какой водитель|bilmayman|kim bu/i;
const YES_OTHER = /^\s*(да|ага|конечно|ha|xa)(?![a-zа-яё])/i;
const NO_OTHER = /^\s*(нет|yo'?q)(?![a-zа-яё])/i;

function readChoice(raw, choices) {
  // "I don't know who this is" is not a "no". It is the owner telling us the
  // question did not say enough, and the answer to that is a clearer question.
  if (UNSURE.test(raw)) return null;
  for (const [vocab, re] of VOCAB) {
    const choice = choices.find((c) => c.vocab === vocab);
    if (choice && re.test(raw)) return choice;
  }
  if (matchesAny(DISMISS, raw) || NO_OTHER.test(raw)) return choices.find((c) => c.answers === 'no') || null;
  if (matchesAny(APPROVE, raw) || YES_OTHER.test(raw)) return choices.find((c) => c.answers === 'yes') || null;
  return null;
}

const BARE_ANSWER = /^\s*(yes|yep|yeah|ya|no|nope|nah|ok|okay|да|нет|ha|yo'?q)\s*[.!]*\s*$/i;

function choiceIntent(choice, raw, remember) {
  // A choice that closes the finding carries its own reason ("it is a
  // driver's chat"). The owner's words win when they said more than the
  // answer itself — a bare "yes" or the button's label is not a reason.
  const bare = BARE_ANSWER.test(raw)
    || raw.trim().toLowerCase() === String(choice.label || '').toLowerCase();
  const reason = bare ? (choice.reason || null) : raw.trim().slice(0, 500);
  return {
    intent: choice.key,
    action: choice.key,
    reason: choice.key === 'dismiss' ? reason : null,
    snoozeHours: null,
    remember,
    note: null,
    value: choice.value ?? null,
  };
}

/**
 * Read one reply.
 *
 * @param {string} text            what the operator typed
 * @param {object} options
 * @param {Array<{key:string,label?:string}>} options.offered  what the question offered
 * @returns {{intent:string, action:string|null, reason:string|null,
 *            snoozeHours:number|null, remember:boolean, note:string|null}}
 */
function parseIntent(text, { offered = [] } = {}) {
  const raw = String(text == null ? '' : text).trim();
  const offeredKeys = new Set(
    (Array.isArray(offered) ? offered : []).map((o) => (o && o.key ? String(o.key) : null)).filter(Boolean)
  );
  const none = {
    intent: 'unclear', action: null, reason: null, snoozeHours: null, remember: false, note: null,
  };

  if (!raw) return { ...none, note: 'empty' };
  if (raw.length > 1000) return { ...none, note: 'too long' };

  const remember = REMEMBER.test(raw);

  // ORDER MATTERS. "not now" and "don't ask again about this, it's fine" both
  // start with a refusal word, so the more specific readings run first:
  // engineering (a complaint about the question itself), then a delay, then
  // yes/no. A reply that matches nothing is unclear, never a default yes.
  if (matchesAny(ENGINEERING, raw)) {
    return { ...none, intent: 'engineering_request', reason: raw.slice(0, 500), remember };
  }

  if (SNOOZE_WORDS.test(raw) || SNOOZE_IN.test(raw)) {
    if (!offeredKeys.has('snooze')) return { ...none, note: 'not offered', remember };
    return {
      intent: 'snooze', action: 'snooze', reason: null,
      snoozeHours: snoozeHoursFrom(raw), remember: false, note: null,
    };
  }

  // A CHOICE QUESTION IS READ BY ITS CHOICES. Plain yes/no rules below would
  // turn "no" into a dismissal, when to "is he still working?" it means "not
  // working" — a real answer, not a refusal to answer.
  const choices = (Array.isArray(offered) ? offered : []).filter((o) => o && o.vocab && offeredKeys.has(o.key));
  if (choices.length) {
    const choice = readChoice(raw, choices);
    return choice ? choiceIntent(choice, raw, remember) : { ...none, remember };
  }

  if (matchesAny(DISMISS, raw)) {
    if (!offeredKeys.has('dismiss')) return { ...none, note: 'not offered', remember };
    return {
      intent: 'dismiss', action: 'dismiss', reason: reasonFrom(raw),
      snoozeHours: null, remember, note: null,
    };
  }

  if (matchesAny(APPROVE, raw)) {
    if (!offeredKeys.has('approve')) return { ...none, note: 'not offered', remember };
    return {
      intent: 'approve', action: 'approve', reason: null,
      snoozeHours: null, remember, note: null,
    };
  }

  return { ...none, remember };
}

module.exports = {
  INTENTS,
  SNOOZE_DEFAULT_HOURS,
  TOMORROW_HOURS,
  VOCAB,
  parseIntent,
  reasonFrom,
};
