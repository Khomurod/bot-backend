/**
 * The kinds of operational notice Wenze sends, and where each one goes. PURE.
 *
 * Before this there was no such thing as "an operational notification". Each
 * feature invented its own destination column, its own outbox table and its own
 * message shape, and a new feature had no choice but to invent a fourth. One of
 * those columns held a chat id with the minus sign dropped and discarded 101
 * staff alerts for months before anybody noticed.
 *
 * So a notice now declares its CATEGORY, and the category decides the chat.
 * An administrator sets one default group and, only where they want the traffic
 * split, a group per category. Anything with no override goes to the default —
 * which means a new category added in code is delivered on the day it ships
 * rather than silently dropped until somebody configures it.
 *
 * `severity` is the routing hint the UI shows, not a rule: it says whether a
 * category is normally worth waking somebody for. `humanActionUsually` is the
 * honest answer to "will I have to do something about these?", which is what
 * decides whether an operator wants them in their own chat or mixed in.
 */

const CATEGORIES = Object.freeze([
  {
    key: 'automatic_corrections',
    label: 'Automatic corrections',
    what: 'Wenze fixed something itself — a driver state, a stale link, a duplicate. '
      + 'Each one is audited and can be undone.',
    severity: 'info',
    humanActionUsually: false,
  },
  {
    key: 'needs_attention',
    label: 'Needs attention',
    what: 'Wenze found something it will not decide on its own and wants a person to look at.',
    severity: 'warning',
    humanActionUsually: true,
  },
  {
    key: 'system_errors',
    label: 'System problems',
    what: 'An integration or a background job is failing in a way that needs a human — '
      + 'not the ones Wenze recovered from by itself.',
    severity: 'serious',
    humanActionUsually: true,
  },
  {
    key: 'self_healing',
    label: 'Wenze fixed itself',
    what: 'An integration failed and Wenze recovered or fell back on its own. '
      + 'Sent so the recovery is visible, not because anything is needed.',
    severity: 'info',
    humanActionUsually: false,
  },
  {
    key: 'fuel',
    label: 'Fuel risks',
    what: 'A truck may be running low, may not reach its assigned stop, or has already passed it.',
    severity: 'warning',
    humanActionUsually: true,
  },
  {
    key: 'safety_escalation',
    label: 'Safety escalation',
    what: 'A driver shows a repeated unsafe pattern rather than a single event, '
      + 'and safety management should see why.',
    severity: 'serious',
    humanActionUsually: true,
  },
  {
    key: 'retention',
    label: 'Driver retention',
    what: 'A driver may be becoming a retention risk, with the reasons and a suggested action.',
    severity: 'warning',
    humanActionUsually: true,
  },
  {
    key: 'load_lifecycle',
    label: 'Load status',
    what: 'A load whose real state Wenze cannot work out, or whose sources disagree.',
    severity: 'warning',
    humanActionUsually: true,
  },
  {
    key: 'ai_learning',
    label: 'AI learning suggestions',
    what: 'Wenze has been corrected the same way several times and suggests a rule change. '
      + 'Nothing changes until an administrator agrees.',
    severity: 'info',
    humanActionUsually: true,
  },
]);

const CATEGORY_KEYS = Object.freeze(CATEGORIES.map((c) => c.key));
const BY_KEY = new Map(CATEGORIES.map((c) => [c.key, c]));

/** @returns {object|null} the catalogue entry, or null for an unknown key. */
function getCategory(key) {
  return BY_KEY.get(String(key || '')) || null;
}

function isKnownCategory(key) {
  return BY_KEY.has(String(key || ''));
}

/**
 * Which chat a category's notice goes to.
 *
 * An override wins; otherwise the default. An EMPTY STRING is not an override —
 * a cleared field in the admin form means "use the default", and treating it as
 * a destination would silently stop delivery.
 *
 * @param {string} category
 * @param {{defaultChatId?: string|null, overrides?: Record<string,string|null>}} routing
 * @returns {{chatId: string|null, via: 'override'|'default'|'none'}}
 */
function resolveDestination(category, { defaultChatId = null, overrides = {} } = {}) {
  const clean = (v) => {
    const s = String(v ?? '').trim();
    return s === '' ? null : s;
  };
  const override = clean(overrides?.[category]);
  if (override) return { chatId: override, via: 'override' };
  const fallback = clean(defaultChatId);
  if (fallback) return { chatId: fallback, via: 'default' };
  return { chatId: null, via: 'none' };
}

module.exports = {
  CATEGORIES,
  CATEGORY_KEYS,
  getCategory,
  isKnownCategory,
  resolveDestination,
};
