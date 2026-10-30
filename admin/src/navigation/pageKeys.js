/**
 * The admin panel's page vocabulary — pure, no React, no I/O.
 *
 * WHY THIS MODULE EXISTS. The same twenty-odd page keys were authored in two
 * independent places — the sidebar's item list and App.jsx's page map — and
 * NOTHING asserted they agreed. A typo in either one produced no error: the
 * lookup missed, the `|| groups` fallback fired, and clicking "Fuel Monitor"
 * (since removed) silently opened Driver Groups. `pageKeys.test.jsx` now holds the three lists
 * to each other, and `PAGE_KEYS` below is the vocabulary they are held to.
 *
 * ONE KEY, ONE PAGE; THE TAB IS THE SECOND HALF. `#settings/board` is the
 * Settings page on its Dispatcher Board section. Until October 2026 several
 * keys opened one page on different tabs (`settings_board`, `settings_ai`, …),
 * and the tab never reached the address — switching tabs left the URL and the
 * sidebar highlight behind. Those keys are now LEGACY_PAGE_KEYS that land on
 * the exact tab. See docs/redesign/structure.md.
 */

/**
 * Every key the admin shell can render. The sidebar and App.jsx agree with this.
 * Grouped as the sidebar groups them (docs/redesign/structure.md).
 */
export const PAGE_KEYS = Object.freeze([
  // Drivers
  'groups',
  'live_locations',
  'home_time',
  'mileage_bonus',
  'retention',
  // Recruiting
  'leads',
  'facebook_leads',
  'recruiter_kpis',
  // Communications
  'communications',
  'company_birthdays',
  // Monitoring
  'operations',
  'system_health',
  // Administration
  'users',
  'settings',
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
 * Keys that used to name a page of their own, and where that content is now —
 * a page, or a page and one of its tabs (`page/tab`).
 *
 * These are NOT dead entries kept for tidiness: a hash link somebody
 * bookmarked or pasted into a chat is an input this application does not
 * control, and the honest answer to `/admin#broadcast` is the screen that
 * content moved to — not a silent fall back to Driver Groups, which looks
 * exactly like the link having been wrong. Each lands on the TAB its old page
 * became, not just the page: `#settings_board` opening Settings on Location
 * Providers would be the same wrong landing with extra steps.
 *
 * Add to this whenever a page key is retired. Removing one breaks a link that
 * may still be in somebody's browser.
 */
export const LEGACY_PAGE_KEYS = Object.freeze({
  // Stage C2 — five messaging screens became tabs of Communications (Messages).
  broadcast: 'communications/send',
  questions: 'communications/surveys',
  scheduled: 'communications/scheduled',
  bot_messages: 'communications/history',
  manager: 'communications/edit_by_link',
  // Stage C3 / C3b — Settings entries that each opened one tab. Since the
  // October 2026 structure there is one Settings entry and every section has
  // its own address.
  settings_integrations: 'settings/location',
  settings_board: 'settings/board',
  settings_ai: 'settings/ai',
  settings_notifications: 'settings/notifications',
  // ONE KEY EACH: pointing both at a single "bot settings" key resolved the
  // link and then opened the wrong screen, which is worse than not resolving it.
  settings_reactions: 'settings/reactions',
  settings_access: 'settings/access',
  auto_reactions: 'settings/reactions',
  group_access: 'settings/access',
});

const KNOWN = new Set(PAGE_KEYS);

/** Split `page/tab` into its halves; a tab may be absent. */
function splitRoute(raw) {
  const [page, tab] = String(raw ?? '').trim().replace(/^#/, '').split('/');
  return { page: (page || '').trim(), tab: (tab || '').trim() || null };
}

/**
 * Turn anything into a route the shell can render: `{ page, tab }`.
 *
 * Order matters: a live key wins over a legacy one, so re-using a retired name
 * for a new page can never be shadowed by its own history. A tab written on a
 * live key is kept as given — the PAGE decides whether it names one of its tabs
 * and opens its first tab otherwise; this module only knows pages. A legacy key
 * brings the tab its content moved to.
 */
export function resolveRoute(raw) {
  const { page, tab } = splitRoute(raw);
  if (KNOWN.has(page)) return { page, tab };
  const moved = LEGACY_PAGE_KEYS[page];
  if (moved) {
    const target = splitRoute(moved);
    if (KNOWN.has(target.page)) return target;
  }
  return { page: DEFAULT_PAGE_KEY, tab: null };
}

/**
 * `/admin#settings/board` → `{ page: 'settings', tab: 'board' }`.
 *
 * No hash at all is no opinion (null): the caller decides, and a path-based
 * public page must not be overridden by an empty hash. Anything unrecognised
 * resolves to the default page, so a mangled or hand-typed hash opens a working
 * screen rather than a blank one. Anything after a second `/` is ignored.
 */
export function routeFromHash(hash) {
  const raw = String(hash ?? '').replace(/^#/, '');
  if (!raw) return null;
  return resolveRoute(raw);
}

/** `('settings', 'board')` → `#settings/board`; no tab → `#settings`. */
export function hashForRoute(page, tab) {
  const route = resolveRoute(page);
  return tab ? `#${route.page}/${tab}` : `#${route.page}${route.tab ? `/${route.tab}` : ''}`;
}
