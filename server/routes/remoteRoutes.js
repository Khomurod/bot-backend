'use strict';

/**
 * The presenter remote page (`GET /remote`).
 *
 * One public route serving one self-contained file: `server/public/remote.html`
 * is the phone remote for the Wenzel Weekly Report deck. The presentation
 * displays a QR encoding `<origin>/remote#c=<CODE>`, so the phone's camera app
 * opens this URL and the page pairs itself from the hash with no taps.
 *
 * PUBLIC ON PURPOSE, AND SAFE TO BE. There is no JWT here and no session: the
 * presenter's phone has no admin credentials, and a QR on a projector cannot
 * carry one. What the page can do is bounded by what it talks to — a public
 * MQTT broker, on a topic named by a four-digit code the deck itself chose,
 * carrying nothing but "next slide". It reads no company data and reaches none
 * of this server's APIs, so an uninvited visitor to `/remote` gets a join card
 * and nothing else.
 *
 * WHY A ROUTE AND NOT `express.static`: a static mount would also expose
 * anything else that ever lands in `server/public/`. One explicit route
 * exposes exactly one file.
 *
 * `no-cache` rather than `no-store`: the phone may revalidate, but it must
 * never present a stale copy after a deploy — a remote that speaks last
 * week's protocol to this week's deck fails silently, mid-talk.
 */

const express = require('express');
const path = require('node:path');

const REMOTE_HTML = path.join(__dirname, '..', 'public', 'remote.html');

function createRemoteRoutes() {
  const router = express.Router();

  function remoteHandler(req, res) {
    res.set('Cache-Control', 'no-cache');
    return res.sendFile(REMOTE_HTML, (err) => {
      // sendFile reports a missing or unreadable file through this callback,
      // after the route has already been entered. Without the headersSent
      // guard this would try to write a second response and crash the request.
      if (err && !res.headersSent) {
        console.error('[REMOTE] could not serve the remote page:', err.message);
        res.status(404).type('text/plain').send('Presenter remote not found.');
      }
    });
  }

  // Both spellings: a QR reader, a typed URL and a copy-paste all produce one
  // or the other, and a 404 on a trailing slash is a dead phone in a live room.
  router.get('/remote', remoteHandler);
  router.get('/remote/', remoteHandler);

  return router;
}

module.exports = { createRemoteRoutes, REMOTE_HTML };
