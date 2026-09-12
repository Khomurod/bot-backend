/**
 * ETA-schedule helpers — pure functions, no I/O and no React.
 *
 * `normalizeEtaEnabled` accepts a boolean, the strings "true"/"false", or the
 * numbers 1/0, because the ETA settings row round-trips through both JSON and
 * Postgres. Anything else is false — an unrecognised value must not read as
 * "ETA updates are on", which is the direction that costs a driver a message
 * they were not meant to get.
 *
 * The rest of this file went with the Dispatch Center's Send Load tab:
 * `resolveChatId`, `stripRateLine`, `formatGroupLabel`, `normalizeClipboardFile`
 * and `ACCEPTED_MIME_TYPES` all existed to decide whose chat a parsed load was
 * sent to and what it said. See `docs/architecture/retired-dispatch-center.md`.
 *
 * Originally split out of admin/src/pages/DispatchPage.jsx.
 */

export function formatIntervalText(intervalMinutes) {
  const safe = Number(intervalMinutes) > 0 ? Number(intervalMinutes) : 0;
  const hours = Math.floor(safe / 60);
  const minutes = safe % 60;
  return `${hours}h ${minutes}m`;
}

export function normalizeEtaEnabled(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  if (typeof value === "number") return value === 1;
  return false;
}

