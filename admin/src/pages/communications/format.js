/**
 * Text and timestamp formatting shared by the Communications tabs.
 *
 * These four helpers were three near-copies before the tabs were gathered onto
 * one page: `truncate`/`formatDate` in broadcast/composerHelpers.js, a private
 * `preview`/`formatSentAt` pair in the history tab, and a bare
 * `.substring(0, 80)` in the scheduled queue.
 *
 * TWO TIMESTAMP FORMATS SURVIVE, DELIBERATELY, and that is the point of writing
 * them down together rather than picking one:
 *
 *   relativeTime — "3 hours ago". For a queue or a recent-sends list, where the
 *   question is "has this gone out yet / how long ago", and an absolute clock
 *   time makes the reader do the arithmetic.
 *
 *   absoluteTime — "Sep 12, 2026, 08:15 PM". For the history tab, where the
 *   question is "what exactly was sent, and when", and the answer may be
 *   pasted into a reply to a driver. "2 months ago" is useless there.
 *
 * `preview` is `truncate` over whitespace-collapsed text with a placeholder for
 * an empty body, because a media-only broadcast has no text and an empty cell
 * reads as a bug. `truncate` on its own keeps the raw string, for the short
 * inline labels next to a history row.
 */
import { timeAgo } from "../../utils/formatTime";

/** "3 hours ago" — for queues and recent sends. */
export const relativeTime = (value) => timeAgo(value);

/** "Sep 12, 2026, 08:15 PM" — for the history tab. An unparseable value is "—". */
export function absoluteTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Cut `text` so the RESULT — marker included — is at most `limit` characters.
 *
 * The limit counts the marker deliberately: every caller is filling a column
 * that was sized for `limit` characters, and the two copies this replaced
 * disagreed about it (the history preview subtracted the marker's width, the
 * broadcast one did not and overran its column by three). A value that already
 * fits is returned whole.
 */
export function truncate(text, limit, ellipsis = "...") {
  const s = String(text ?? "");
  if (s.length <= limit) return s;
  return s.slice(0, Math.max(0, limit - ellipsis.length)) + ellipsis;
}

/**
 * One-line preview of a message body: whitespace collapsed so a multi-line
 * broadcast does not break the row, cut at `limit`, and an explicit placeholder
 * when there is no text at all.
 */
export function preview(text, limit = 160, empty = "(media message without text)") {
  const collapsed = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!collapsed) return empty;
  return truncate(collapsed, limit, "…");
}
