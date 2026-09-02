import { createPasteRouter } from "../pasteTarget.mjs";

/**
 * THE single paste-target router for the Route Control page — one instance,
 * one owner, this module.
 *
 * Whichever screenshot dropzone was last focused or opened is the sole
 * destination for a Ctrl+V image. One window paste listener (in
 * RouteControlPage) dispatches through it, so a paste inside a route's "Manage
 * screenshot" panel never leaks into the assign form above it.
 *
 * It is deliberately module-level shared mutable state: the assign form, every
 * route row, and the page's window listener must all agree on which dropzone is
 * active, and per-component routers could not. Everything that claims focus
 * registers under a distinct key ("assign", `row:<id>`) and clears it on
 * unmount.
 *
 * Split out of admin/src/pages/RouteControlPage.jsx.
 */
export const pasteRouter = createPasteRouter();
