/**
 * The admin panel's page vocabulary — pure, no React, no I/O.
 *
 * WHY THIS MODULE EXISTS. The same twenty-odd page keys were authored in two
 * independent places — the sidebar's item list and App.jsx's page map — and
 * NOTHING asserted they agreed. A typo in either one produced no error: the
 * lookup missed, the `|| groups` fallback fired, and clicking "Fuel Monitor"
 * silently opened Driver Groups. `pageKeys.test.jsx` now holds the three lists
 * to each other, and `PAGE_KEYS` below is the vocabulary they are held to.
 *
 * A KEY IS NOT A COMPONENT. Several keys deliberately open the same component
 * on a different tab — `settings_board` and `settings_ai` are both the Settings
 * page, `system_health` is the Operations page — because the thing a person
 * looks for in a sidebar ("Dispatcher Board") is not the thing the code happens
 * to have built as a component.
 */

/** Every key the admin shell can render. The sidebar and App.jsx agree with this. */
export const PAGE_KEYS = Object.freeze([
  // Operations
  'operations',
  'live_locations',
  'route_control',
  'fuel_monitor',
  'home_time',
  'system_health',
  // Groups
  'groups',
  'mileage_bonus',
  'raise_approval',
  // Communications
  'communications',
  'company_birthdays',
  // Recruiting
  'leads',
  'facebook_leads',
  'recruiter_kpis',
  // Settings
  'users',
  'settings_integrations',
  'settings_board',
  'settings_ai',
  'settings_finance',
  'settings_notifications',
  'settings_reactions',
  'settings_access',
]);

/**
 * The page opened when nothing else resolves.
 *
 * Driver Groups, because it is the screen this application is most about and
 * the one an administrator opens first — not because it is alphabetically
 * lucky. It was already the fallback in App.jsx; naming it makes the choice
 * visible instead of a bare `|| pages.groups`.
 */
export const DEFAULT_PAGE_KEY = 'groups';

/**
 * Keys that used to name a page of their own and now name a tab of one.
 *
 * These are NOT dead entries kept for tidiness: a hash link somebody
 * bookmarked or pasted into a chat is an input this application does not
 * control, and the honest answer to `/admin#broadcast` is the screen that
 * content moved to — not a silent fall back to Driver Groups, which looks
 * exactly like the link having been wrong.
 *
 * Add to this whenever a page key is retired. Removing one breaks a link that
 * may still be in somebody's browser.
 */
export const LEGACY_PAGE_KEYS = Object.freeze({
  // Stage C2 — five messaging screens became tabs of Communications.
  broadcast: 'communications',
  questions: 'communications',
  scheduled: 'communications',
  bot_messages: 'communications',
  manager: 'communications',
  // Stage C3 — "Settings" alone no longer says which settings.
  settings: 'settings_integrations',
  // Stage C3b — two top-level pages became tabs of Settings. ONE KEY EACH:
  // pointing both at a single "bot settings" key resolved the link and then
  // opened the wrong screen, which is worse than not resolving it.
  auto_reactions: 'settings_reactions',
  group_access: 'settings_access',
});

const KNOWN = new Set(PAGE_KEYS);

/**
 * Turn anything into a key the shell can render.
 *
 * Order matters: a live key wins over a legacy one, so re-using a retired name
 * for a new page can never be shadowed by its own history.
 */
export function resolvePageKey(raw) {
  const key = String(raw ?? '').trim();
  if (KNOWN.has(key)) return key;
  const moved = LEGACY_PAGE_KEYS[key];
  if (moved && KNOWN.has(moved)) return moved;
  return DEFAULT_PAGE_KEY;
}

/** True when `raw` names a live page — used to tell "unknown" from "moved". */
export function isLivePageKey(raw) {
  return KNOWN.has(String(raw ?? '').trim());
}

/**
 * `/admin#fuel_monitor` → `fuel_monitor`.
 *
 * Everything after the first `/` is ignored: `#communications/scheduled` is a
 * page key and a hint at a tab within it, and only the page half is this
 * module's business. Anything unrecognised resolves to the default, so a
 * mangled or hand-typed hash opens a working screen rather than a blank one.
 */
export function pageKeyFromHash(hash) {
  const raw = String(hash ?? '').replace(/^#/, '');
  if (!raw) return null;
  return resolvePageKey(raw.split('/')[0]);
}

/** `fuel_monitor` → `#fuel_monitor`. The inverse of the page half above. */
export function hashForPageKey(key) {
  return `#${resolvePageKey(key)}`;
}
