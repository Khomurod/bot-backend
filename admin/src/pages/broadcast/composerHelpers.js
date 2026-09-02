import { timeAgo } from "../../utils/formatTime";

/**
 * Small pure helpers shared by both composers and both history lists.
 *
 * translateErrorText keeps the server's own message when it explains a
 * configuration problem ("AI is not configured") and only prefixes generic
 * failures — an admin who sees the real reason can fix it, whereas a wrapped
 * "Translation failed" sends them to the wrong place.
 *
 * normalizeMediaItems strips the client-only fields off an upload descriptor so
 * the send payload carries exactly what the API accepts.
 *
 * Split out of admin/src/pages/BroadcastPage.jsx.
 */
export function translateErrorText(err, fallbackPrefix) {
  const message = err?.message || 'Unknown error';
  if (message.includes('AI is not configured')) return message;
  return `${fallbackPrefix}: ${message}`;
}

/**
 * Flatten and compact a media-item list for the send payload.
 *
 * MediaUploader can hand back nested arrays (one entry per file of a
 * multi-select), so this flattens one level and drops falsy entries. It does
 * NOT pick fields — the API consumes the uploader's descriptors as they are,
 * and narrowing them here would silently drop whatever the uploader adds next.
 */
export function normalizeMediaItems(items) {
  return (
    Array.isArray(items)
      ? items.flatMap((m) => (Array.isArray(m) ? m : [m])).filter(Boolean)
      : []
  );
}

/** Weekday options for a weekly schedule (ISO: 1 = Monday … 7 = Sunday). */
export const WEEKLY_DAY_OPTIONS = [
  { value: '1', label: 'Monday' },
  { value: '2', label: 'Tuesday' },
  { value: '3', label: 'Wednesday' },
  { value: '4', label: 'Thursday' },
  { value: '5', label: 'Friday' },
  { value: '6', label: 'Saturday' },
  { value: '7', label: 'Sunday' },
];

export const formatDate = (d) => timeAgo(d);
export const truncate = (s, n) => (s?.length > n ? s.substring(0, n) + '...' : s);
