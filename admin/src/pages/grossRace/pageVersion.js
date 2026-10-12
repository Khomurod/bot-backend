/**
 * A screen running an old build of the race page reloads itself (the owner,
 * 12 October 2026: no reloading every screen by hand after a code update).
 *
 * The server names the build it hands out with every answer — the page
 * chunk's file name, which Vite hashes from its content
 * (services/grossRace/pageVersion.js). The page knows its own from
 * `import.meta.url`. Different names: this screen is behind. The name changes
 * with any admin code change (the chunk imports the panel's main chunk), so
 * a screen reloads after every admin update, never after a server-only one.
 */
import { celebrationCue } from "./celebration/celebrationTime";

const CHUNK = /^GrossRacePage-[\w-]+\.js$/;
const RELOADED_AT = "grossRace.reloadedAt";
export const RELOAD_GAP_MS = 5 * 60_000;
export const CONFIRMATIONS = 2;

/** The race page's chunk name in a module URL; null outside a build (dev, tests). */
export function chunkOf(url) {
  const name = String(url || "").split(/[?#]/)[0].split("/").pop();
  return CHUNK.test(name) ? name : null;
}

/**
 * How many answers in a row have named the same build other than ours. A hash
 * says which build, not which is newer: while a deploy switches over, a screen
 * already on the new build can get one answer from the old server. Asking for
 * the same other name twice, a poll apart, lets that one answer pass; a real
 * new build is still there on the next poll.
 */
export function noteServed(seen, served, own) {
  if (!served || served === own) return { name: null, count: 0 };
  return seen && seen.name === served ? { name: served, count: seen.count + 1 } : { name: served, count: 1 };
}

/**
 * Whether to reload now. Only when both sides name a built race page, the
 * names differ, and the server's has been named in CONFIRMATIONS answers in a
 * row (noteServed). Never while the 4 PM celebration is on screen or due this
 * minute: a fresh page would celebrate a second time. And never twice within
 * five minutes, so whatever a deploy in progress answers, a screen cannot be
 * set reloading over and over.
 */
export function shouldReload({ own, served, confirmations, now, tz, celebrating, lastReloadAt }) {
  if (!own || !served || !CHUNK.test(served) || own === served) return false;
  if (!(confirmations >= CONFIRMATIONS)) return false;
  if (celebrating || celebrationCue(now, tz, null).cue === "show") return false;
  return !(lastReloadAt && now - lastReloadAt < RELOAD_GAP_MS);
}

/** This tab's sessionStorage, or null where even asking for it throws. */
export function tabStorage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** When this tab last reloaded itself; 0 if never, or if storage is unavailable. */
export function lastReloadAt(storage) {
  try {
    return Number(storage.getItem(RELOADED_AT)) || 0;
  } catch {
    return 0;
  }
}

/** Remembers the reload for this tab. Without storage the gap is simply not kept. */
export function markReload(storage, at) {
  try {
    storage.setItem(RELOADED_AT, String(at));
  } catch {
    // Private mode or storage disabled: nothing to remember it in.
  }
}
