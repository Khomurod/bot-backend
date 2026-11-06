/**
 * Whose birthday this screen shows next (the owner, 6 November 2026). Pure,
 * apart from the tab's own storage, which may be missing or refuse a write.
 *
 * Each birthday the server holds is shown ONCE per tab, in the order they went
 * out to Telegram, about fifteen seconds each. What was shown is kept in the
 * tab's sessionStorage, so the board's own reload after a deploy does not
 * congratulate everybody again; a screen opened later in the day still shows
 * them once.
 */
export const BIRTHDAY_MS = 15_000;
export const SHOWN_KEY = "grossRace.birthdaysShown";
const MAX_REMEMBERED = 100;

/** The first birthday not shown yet in this tab, or null. */
export function nextBirthday(birthdays, shown) {
  for (const birthday of birthdays || []) {
    if (birthday && birthday.key && birthday.name && !shown.has(birthday.key)) return birthday;
  }
  return null;
}

/** The keys this tab already showed; empty when storage is missing or unreadable. */
export function readShown(storage) {
  try {
    const list = JSON.parse(storage.getItem(SHOWN_KEY) || "[]");
    return new Set(Array.isArray(list) ? list.filter((k) => typeof k === "string") : []);
  } catch {
    return new Set();
  }
}

/** Remember a shown key (the last MAX_REMEMBERED). Never throws. */
export function markShown(storage, shown, key) {
  shown.add(key);
  try {
    storage.setItem(SHOWN_KEY, JSON.stringify([...shown].slice(-MAX_REMEMBERED)));
  } catch {
    // Kept in memory for this page: at worst a reload shows it once more.
  }
  return shown;
}
