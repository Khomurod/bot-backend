/**
 * Dispatch Center helpers — pure functions, no I/O and no React.
 *
 * resolveChatId is the one that matters. The group field accepts either a
 * picked group label or a hand-pasted Telegram chat id, and the resolved id
 * decides WHOSE Telegram group receives a load. An exact label match wins; only
 * when nothing matches does it fall back to the trailing @handle-or-numeric-id
 * in the text. Loosening that order would let a partial label silently resolve
 * to the wrong driver.
 *
 * stripRateLine removes the rate from the message body when an admin chooses
 * not to disclose it — the parsed text is sent verbatim otherwise, so the
 * removal has to happen here rather than being trusted to the server.
 *
 * normalizeEtaEnabled accepts a boolean, the strings "true"/"false", or the
 * numbers 1/0, because the ETA settings row round-trips through both JSON and
 * Postgres. Anything else is false — an unrecognised value must not read as
 * "ETA updates are on".
 *
 * Split out of admin/src/pages/DispatchPage.jsx.
 */
export const ACCEPTED_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export function getFileExtension(mimeType) {
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  return "bin";
}

export function normalizeClipboardFile(file) {
  if (!file) return null;
  if (file.name) return file;
  return new File(
    [file],
    `clipboard-${Date.now()}.${getFileExtension(file.type)}`,
    { type: file.type || "application/octet-stream" }
  );
}

export function formatGroupLabel(group) {
  const driverName = [group.driver_first_name, group.driver_last_name]
    .filter(Boolean)
    .join(" ");
  return driverName
    ? `${group.group_name} — ${driverName}`
    : group.group_name;
}

export function stripRateLine(text) {
  return String(text || "")
    .split(/\r?\n/)
    .filter((line) => !/^Rate:\s*/i.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function resolveChatId(groupInput, groups) {
  const trimmed = String(groupInput || "").trim();
  if (!trimmed) return "";

  const exactMatch = groups.find(
    (group) =>
      group.label === trimmed ||
      group.group_name === trimmed ||
      String(group.telegram_group_id || "") === trimmed
  );
  if (exactMatch) {
    return String(exactMatch.telegram_group_id || "").trim();
  }

  const idMatch = trimmed.match(/(@[A-Za-z0-9_]+|-?\d+)\s*$/);
  return idMatch ? idMatch[1] : trimmed;
}

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

export function formatOptionalDateTime(value, { future = false } = {}) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  if (future) return date.toLocaleString();
  return timeAgo(value);
}
