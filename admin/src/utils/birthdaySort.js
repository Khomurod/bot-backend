/**
 * Days until the next occurrence of a birthday (month/day), for admin list sorting.
 * @param {string|null|undefined} dateString - YYYY-MM-DD or ISO date string
 * @returns {number} Days until next birthday; Infinity if missing/invalid
 */
export function getDaysUntilBirthday(dateString) {
  if (!dateString) return Infinity;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const bday = new Date(dateString);
  if (Number.isNaN(bday.getTime())) return Infinity;
  let nextBday = new Date(today.getFullYear(), bday.getUTCMonth(), bday.getUTCDate());
  if (nextBday < today) {
    nextBday.setFullYear(today.getFullYear() + 1);
  }
  return Math.ceil((nextBday - today) / (1000 * 60 * 60 * 24));
}

/**
 * @template T
 * @param {T[]} items
 * @param {(item: T) => string|null|undefined} getBirthday
 * @returns {T[]}
 */
export function sortBySoonestBirthday(items, getBirthday) {
  return [...items].sort(
    (a, b) => getDaysUntilBirthday(getBirthday(a)) - getDaysUntilBirthday(getBirthday(b)),
  );
}

/**
 * Parse driver display name from Telegram group title (e.g. WENZE UNIT # 2908 NAME).
 * @param {string|null|undefined} groupName
 * @returns {string|null}
 */
export function parseDriverNameFromGroupTitle(groupName) {
  if (!groupName) return null;
  let cleaned = String(groupName).trim();
  const parenMatch = cleaned.match(/\(([^)]+)\)\s*$/);
  if (parenMatch) {
    cleaned = cleaned.replace(/\([^)]+\)\s*$/, '').trim();
  }
  const patterns = [
    /^.+?\s+UNIT\s*#\s*\d+\s+(.+)$/i,
    /^.+?\s+#\s*\d+\s+(.+)$/i,
    /^.+?\s+UNIT\s+\d+\s+(.+)$/i,
  ];
  for (const re of patterns) {
    const m = cleaned.match(re);
    if (m) return m[1].trim();
  }
  return null;
}
