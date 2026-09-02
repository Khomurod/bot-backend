/**
 * Placeholder-token validation for broadcast message templates — pure.
 *
 * A broadcast goes to every driver group at once and cannot be recalled, so an
 * UNKNOWN token is treated as an error before sending rather than rendered
 * literally: "{frist_name}" reaching hundreds of drivers as text is not
 * recoverable, and the server would have no way to guess the intent.
 *
 * The allowed set comes from the server's placeholder list when it is
 * available; DEFAULT_BROADCAST_PLACEHOLDER_KEYS is the fallback so a failed
 * placeholder fetch cannot make every token look invalid and block all sends.
 *
 * Split out of admin/src/pages/BroadcastPage.jsx.
 */
export const TEMPLATE_TOKEN_PATTERN = /\{([a-z][a-z0-9_]*)\}/gi;
export const DEFAULT_BROADCAST_PLACEHOLDER_KEYS = [
  'driver_name',
  'first_name',
  'last_name',
  'unit_number',
  'driver_type',
  'status',
  'language',
  'date_of_birth',
  'date_of_start',
];

export function extractUnknownTokens(text, allowedKeys) {
  const source = String(text || '');
  const unknown = new Set();
  let match = TEMPLATE_TOKEN_PATTERN.exec(source);
  while (match) {
    const key = String(match[1] || '').toLowerCase();
    if (!allowedKeys.has(key)) unknown.add(key);
    match = TEMPLATE_TOKEN_PATTERN.exec(source);
  }
  TEMPLATE_TOKEN_PATTERN.lastIndex = 0;
  return [...unknown];
}

// Auto-translate runs on the app's integrated AI (no Send-Message-specific
// provider). When the backend reports the AI is unconfigured, show its message
