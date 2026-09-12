'use strict';

/**
 * Gone-but-not-forgotten page URLs.
 *
 * The Trailer Department (`/trailers`), Trailer Tracking, and the QBQ/SOS
 * assessment and presentation (`/questions`, `/answers`, `/qbq`) have been
 * removed. Their URLs are still in browser bookmarks, in chat history and in
 * printed material, so they need an answer that says what happened rather than
 * Express's default "Cannot GET /trailers" — and rather than the admin SPA
 * shell, which is what they used to resolve to and would now render an empty
 * page for a section that no longer exists.
 *
 * 410 Gone, not 404: the resource existed and was deliberately withdrawn, which
 * is exactly what a crawler or a person should be told. `ALL` rather than `GET`
 * so an old form post gets the same explanation instead of a bare 404.
 *
 * Removed `/api/*` endpoints are NOT listed here on purpose — they 404 like any
 * other unknown API path, which is the correct answer for a JSON client.
 *
 * Mounted immediately before the admin SPA catch-all in server/api.js, so any
 * surviving route still wins.
 */
const express = require('express');

// Page prefixes whose feature has been removed. Keep this list exact: a bare
// prefix would shadow a future route that legitimately reuses the word.
//
// `/admin/trailers` is here because it was the Trailer Department's ORIGINAL
// slug and the code that superseded it promised it would "stay readable
// forever" — the SPA rewrote such a URL to `/trailers` on mount, so the
// bookmarks people actually hold are of both shapes. Without this entry the
// legacy prefix falls through to the `/admin/*` SPA catch-all and the shell,
// finding no trailer section, silently renders Driver Groups instead: a removed
// bookmark quietly opening an unrelated page, which is worse than an error.
//
// `/dispatch` is here because the Dispatch Center was a PUBLIC-looking page at
// its own root path rather than a tab inside `/admin`, so dispatchers hold
// bookmarks to it. Without this entry it falls through to the SPA catch-all and
// the shell, finding no dispatch section, silently renders Driver Groups —
// exactly the failure the trailers entry above was added for. `/api/dispatch`
// is NOT retired: the four ETA-schedule endpoints under it are live and moved
// to Settings, and the prefixes here are page paths only.
const RETIRED_PAGE_PATHS = [
  '/trailers', '/trailers/*',
  '/dispatch', '/dispatch/*',
  '/admin/trailers', '/admin/trailers/*',
  '/questions', '/questions/*',
  '/answers', '/answers/*',
  '/qbq', '/qbq/*',
];

const BODY = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Feature removed</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;
       font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
       background:#f6f7f9;color:#1f2933}
  main{max-width:34rem;padding:2rem;text-align:center}
  h1{font-size:1.25rem;margin:0 0 .5rem}
  p{margin:0 0 1rem;color:#52606d}
  a{color:#2563eb}
</style></head>
<body><main>
<h1>This feature has been removed</h1>
<p>The page you followed belonged to a feature that is no longer part of this
application. Nothing is broken &mdash; there is simply nothing here any more.</p>
<p><a href="/admin">Go to the admin panel</a></p>
</main></body></html>
`;

function createRetiredRoutes() {
  const router = express.Router();
  router.all(RETIRED_PAGE_PATHS, (req, res) => {
    res.status(410).type('html').send(BODY);
  });
  return router;
}

module.exports = { createRetiredRoutes, RETIRED_PAGE_PATHS };
