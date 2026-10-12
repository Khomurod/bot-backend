'use strict';

/**
 * Which build of the race page this server hands out, so a screen running an
 * older one can reload itself (the owner, 12 October 2026: the boards should
 * update by themselves after a code update, without anyone reloading them).
 *
 * Vite names the page's chunk after its file and a hash of its content —
 * GrossRacePage-<hash>.js. That content includes the names of the chunks it
 * imports, the admin panel's main chunk among them, so the name changes
 * whenever ANY admin code changes, not only this page's (checked: editing the
 * Samsara settings tab renamed it). A deploy that touches only the server
 * leaves it alone.
 *
 * Read once, on first use: the build does not change while this process runs
 * (a deploy is a new process). Anything but exactly one such chunk — no build
 * at all (tests, `vite dev`), or a stale one beside a fresh one — is null,
 * which the page reads as "nothing to compare", never as a reason to reload.
 */

const fs = require('fs');

const RACE_PAGE_CHUNK = /^GrossRacePage-[\w-]+\.js$/;

/** The race page's chunk among a build's asset file names, or null. Pure. */
function racePageChunk(fileNames) {
  const matches = (fileNames || []).filter((name) => RACE_PAGE_CHUNK.test(name));
  return matches.length === 1 ? matches[0] : null;
}

/** `() => chunk name | null`, reading `assetsDir` the first time it is asked. */
function createRacePageVersion({ assetsDir, readdir = fs.readdirSync } = {}) {
  let known;
  return function racePageVersion() {
    if (known === undefined) {
      try {
        known = racePageChunk(readdir(assetsDir));
      } catch {
        known = null;
      }
    }
    return known;
  };
}

module.exports = { createRacePageVersion, racePageChunk };
