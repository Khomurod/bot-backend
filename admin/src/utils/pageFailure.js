/**
 * What went wrong, in words an admin can act on.
 *
 * WHY THIS EXISTS. Every failure in the admin panel used to surface as the same
 * sentence — "Could not load this page (a new version may have been
 * deployed)" — whether the real cause was a ReferenceError in the page's own
 * code, an expired session, a missing permission, Supabase being unreachable,
 * or a genuinely outdated browser tab. Four of those five suggestions were
 * wrong every time, and the one true cause was never visible. Worse, a reload
 * "fixed" nothing, so the message trained everyone to distrust the panel.
 *
 * This module answers one question — WHICH kind of failure is this — and
 * returns the wording plus the single action that actually helps. It is pure:
 * no React, no fetch, no DOM, so it is unit-tested directly.
 *
 * The underlying message is never swallowed: `technical` always carries the
 * real text, because the person reading it is an administrator, and a hidden
 * cause is how an incident lasts a week.
 */

/** Failure classes the UI distinguishes. */
export const FAILURE_KIND = {
  /** The browser is running an outdated build; a file it wants no longer exists. */
  STALE_BUNDLE: 'stale_bundle',
  /** A bug in this section's own code (ReferenceError, TypeError…). */
  CODE: 'code',
  /** The session is gone or was never valid. */
  AUTH: 'auth',
  /** Signed in, but this account may not use this section. */
  PERMISSION: 'permission',
  /** A plan/usage limit was reached (Supabase transfer, storage, rate limit). */
  QUOTA: 'quota',
  /** The database itself could not be reached or refused the work. */
  DATABASE: 'database',
  /** This browser has no working connection to the server. */
  NETWORK: 'network',
  /** The server reached the code and failed there. */
  SERVER: 'server',
  /** The endpoint or record does not exist. */
  NOT_FOUND: 'not_found',
  UNKNOWN: 'unknown',
};

/**
 * Codes the API sends in an error body. The server side of this vocabulary
 * lives in lib/errors/failureCodes.js, and a test asserts the two agree.
 */
const CODE_KINDS = {
  DB_UNAVAILABLE: FAILURE_KIND.DATABASE,
  DB_TIMEOUT: FAILURE_KIND.DATABASE,
  DB_PERMISSION: FAILURE_KIND.DATABASE,
  DB_ERROR: FAILURE_KIND.DATABASE,
  DB_QUOTA: FAILURE_KIND.QUOTA,
  QUOTA_EXCEEDED: FAILURE_KIND.QUOTA,
  RATE_LIMITED: FAILURE_KIND.QUOTA,
};

/** A failed dynamic import — the signature of a replaced or missing chunk. */
const STALE_BUNDLE_PATTERNS = [
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
  /loading chunk \S+ failed/i,
  /unable to preload css/i,
];

/** A browser that could not reach the server at all. */
const NETWORK_PATTERNS = [
  /failed to fetch/i,
  /networkerror/i,
  /network request failed/i,
  /load failed/i,
  /the internet connection appears to be offline/i,
];

/**
 * Database-failure signatures, for a 500 whose body carries the driver's own
 * message. Endpoints classified server-side send a `code` instead; this is the
 * safety net for the ones that only forward `err.message`.
 */
const DATABASE_PATTERNS = [
  /too many clients/i,
  /remaining connection slots/i,
  /connection terminated/i,
  /connection to the database/i,
  /client has encountered a connection error/i,
  /econnrefused/i,
  /enotfound/i,
  /etimedout/i,
  /timeout expired/i,
  /terminating connection/i,
  /ssl connection has been closed/i,
  /server closed the connection unexpectedly/i,
  /database is (not available|unavailable)/i,
];

/** A plan or usage limit rather than a fault. */
const QUOTA_PATTERNS = [
  /quota/i,
  /egress/i,
  /data transfer/i,
  /exceeded .*(limit|allowance|plan)/i,
  /too many requests/i,
  /project is paused/i,
];

const CODE_ERROR_NAMES = new Set(['ReferenceError', 'TypeError', 'SyntaxError', 'RangeError']);

const matches = (patterns, text) => Boolean(text) && patterns.some((re) => re.test(text));

/** The message of an error, however it was thrown. */
function messageOf(error) {
  if (!error) return '';
  if (typeof error === 'string') return error;
  return String(error.message || error);
}

/** Wording + the one action that helps, per kind. */
const PRESENTATION = {
  [FAILURE_KIND.STALE_BUNDLE]: {
    title: 'This tab is running an outdated version',
    explanation:
      'The app was rebuilt after this tab was opened, so a file this section needs is no longer on the server. Reloading loads the current version. Nothing was lost, and other sections keep working.',
    action: 'reload',
  },
  [FAILURE_KIND.CODE]: {
    title: 'This section has a bug',
    explanation:
      'The page stopped while building its view, so this is a fault in the code rather than in your data or your connection. Nothing was saved or changed. Every other section is unaffected — switch to one from the sidebar, and send the detail below to whoever maintains the panel.',
    action: 'retry',
  },
  [FAILURE_KIND.AUTH]: {
    title: 'Your session has ended',
    explanation: 'Sign in again to continue. Your data is untouched.',
    action: 'signin',
  },
  [FAILURE_KIND.PERMISSION]: {
    title: 'This account may not open this section',
    explanation:
      'You are signed in, but your permissions do not include this area. An administrator can grant it under Users. This is a permission decision, not a failure.',
    action: 'none',
  },
  [FAILURE_KIND.QUOTA]: {
    title: 'A usage limit was reached',
    explanation:
      'The request was refused because a plan or rate limit is exhausted, not because anything is broken. Existing data is intact and nothing was deleted. Wait for the limit to reset, or reduce usage — see the detail below for which limit it was.',
    action: 'retry',
  },
  [FAILURE_KIND.DATABASE]: {
    title: 'The database could not be reached',
    explanation:
      'The app is running, but its database (Supabase) did not answer, so this section has no data to show. This is NOT an empty list: nothing has been lost, and no data was written. Try again in a moment; if it persists, check the Supabase project status.',
    action: 'retry',
  },
  [FAILURE_KIND.NETWORK]: {
    title: 'No connection to the server',
    explanation:
      'This browser could not reach the app at all — usually a dropped network, a sleeping laptop, or the server restarting after a deploy. Nothing was sent, so nothing was half-saved.',
    action: 'retry',
  },
  [FAILURE_KIND.SERVER]: {
    title: 'The server failed on this request',
    explanation:
      'The request reached the app and the app itself errored. Your data is unchanged unless the message below says otherwise. Retrying is safe for a page load; check the server logs for the cause.',
    action: 'retry',
  },
  [FAILURE_KIND.NOT_FOUND]: {
    title: 'Not found',
    explanation:
      'The address this section asked for does not exist on the server. If the app was just deployed, reload; otherwise this is a wrong link or a removed record.',
    action: 'reload',
  },
  [FAILURE_KIND.UNKNOWN]: {
    title: 'Something went wrong',
    explanation:
      'The failure did not match anything recognizable, so the exact message is below rather than replaced by a guess.',
    action: 'retry',
  },
};

const ACTION_LABELS = {
  reload: 'Reload the app',
  retry: 'Try again',
  signin: 'Sign in again',
  none: null,
};

/** Which class of failure is this? (kind only — see classifyFailure for wording.) */
export function failureKind(error) {
  if (!error) return FAILURE_KIND.UNKNOWN;
  const message = messageOf(error);
  const name = error.name || '';

  if (name === 'ChunkLoadError' || matches(STALE_BUNDLE_PATTERNS, message)) {
    return FAILURE_KIND.STALE_BUNDLE;
  }

  const status = Number(error.status) || 0;
  const code = error.code ? String(error.code).toUpperCase() : '';
  if (CODE_KINDS[code]) return CODE_KINDS[code];

  if (status) {
    if (status === 401) return FAILURE_KIND.AUTH;
    if (status === 403) return FAILURE_KIND.PERMISSION;
    if (status === 402 || status === 429) return FAILURE_KIND.QUOTA;
    // HTML from an API path means the SPA catch-all answered: this tab is
    // asking for an endpoint the deployed server does not have.
    if (status === 404) return error.htmlBody ? FAILURE_KIND.STALE_BUNDLE : FAILURE_KIND.NOT_FOUND;
    if (status >= 500) {
      if (matches(QUOTA_PATTERNS, message)) return FAILURE_KIND.QUOTA;
      if (matches(DATABASE_PATTERNS, message)) return FAILURE_KIND.DATABASE;
      return FAILURE_KIND.SERVER;
    }
    if (status >= 400) return FAILURE_KIND.SERVER;
  }

  if (matches(NETWORK_PATTERNS, message)) return FAILURE_KIND.NETWORK;
  if (matches(DATABASE_PATTERNS, message)) return FAILURE_KIND.DATABASE;
  if (CODE_ERROR_NAMES.has(name)) return FAILURE_KIND.CODE;
  return FAILURE_KIND.UNKNOWN;
}

/**
 * Classify a failure and describe it: `{ kind, title, explanation, technical,
 * action, actionLabel }`. `where` (a component stack line, a page name) is
 * appended to `technical` when given.
 */
export function classifyFailure(error, { where = '' } = {}) {
  const kind = failureKind(error);
  const presentation = PRESENTATION[kind] || PRESENTATION[FAILURE_KIND.UNKNOWN];
  const message = messageOf(error) || 'No error message was provided.';
  const status = Number(error?.status) || 0;
  const parts = [
    error?.name && error.name !== 'Error' ? `${error.name}: ${message}` : message,
    status ? `HTTP ${status}` : '',
    error?.code ? `code ${error.code}` : '',
    where || '',
  ];
  return {
    kind,
    title: presentation.title,
    explanation: presentation.explanation,
    technical: parts.filter(Boolean).join(' · '),
    action: presentation.action,
    actionLabel: ACTION_LABELS[presentation.action],
  };
}
