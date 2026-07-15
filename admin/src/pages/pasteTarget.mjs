/**
 * Tiny paste-target router for Route Control screenshot dropzones.
 *
 * Problem it solves: the page has several screenshot dropzones (the "Assign a
 * route" form + one per existing route's "Manage screenshot" panel). A single
 * window-level paste listener used to always feed the top form, so Ctrl+V inside
 * a route's panel put the image in the wrong place. This router keeps exactly
 * ONE active target at a time (whichever dropzone was last focused/opened) and
 * routes a pasted image only there — an unambiguous destination, testable
 * without a DOM (this repo has no frontend DOM test runner).
 *
 * Dependency-light ESM (only the pure clipboard extractor) so it is unit-tested
 * under node:test, mirroring routeControlGroupSearch.mjs / routeScreenshot.mjs.
 */
import { imageFromClipboard } from "./routeScreenshot.mjs";

export function createPasteRouter() {
  let active = null; // { id, accept } | null

  return {
    /** Make `id` the sole active paste target, handled by `accept(file)`. */
    setActive(id, accept) {
      if (id == null) return;
      active = { id, accept: typeof accept === "function" ? accept : null };
    },
    /** Clear the active target only if it is still `id` (a later target wins). */
    clearActive(id) {
      if (active && active.id === id) active = null;
    },
    getActiveId() {
      return active ? active.id : null;
    },
    /**
     * Route a paste's clipboard items to the active target. Returns the id that
     * handled it, or null when ignored (no active target, or the clipboard has
     * no image — e.g. plain text, which must keep pasting normally).
     */
    handlePaste(items) {
      if (!active || !active.accept) return null;
      const file = imageFromClipboard(items);
      if (!file) return null;
      active.accept(file);
      return active.id;
    },
  };
}
