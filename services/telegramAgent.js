const https = require('https');

// ─── IPv4-pinned HTTPS agent for all Telegram Bot API traffic ───
//
// Symptom this fixes: on the production host, small Telegram requests
// (getUpdates long-poll, sendMessage) work fine, but *file uploads*
// (sendPhoto/sendVideo/sendDocument with an actual file body) stall until they
// time out — even for a 0.3MB photo. That is the classic signature of a broken
// IPv6 / path-MTU-black-hole route: a single-packet request slips through, but
// the multi-packet body of an upload never gets acknowledged.
//
// api.telegram.org publishes both A and AAAA records, and modern Node keeps
// DNS results in resolver order (`verbatim`), so the client can pick the IPv6
// address and hang. Pinning `family: 4` forces IPv4, which is known-good on the
// host (that is the path polling and text sends already use successfully).
//
// telegraf sets `config.agent = options.agent` for *every* call, uploads
// included (see telegraf/lib/core/network/client.js), so overriding this one
// agent covers normal API calls and attachment uploads alike. We reuse a single
// keep-alive agent across all three bot clients to avoid piling up sockets on
// the memory-constrained instance.
const telegramIpv4Agent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 10000,
  family: 4,
});

// Telegraf's `Telegram`/`Telegraf` constructors take a `telegram` options bag
// with `agent` (normal calls) and `attachmentAgent` (used when telegraf itself
// fetches a remote media URL to re-upload). Pin both to IPv4.
const telegramClientOptions = {
  agent: telegramIpv4Agent,
  attachmentAgent: telegramIpv4Agent,
};

// ─── Route Control media-edit client (editMessageMedia uploads) ───
//
// Route Control replaces/converts a driver-group message's photo by uploading a
// fresh multipart body via the raw `callApi('editMessageMedia', payload,
// { signal })`, with a real AbortController per attempt (services/telegramEdit).
//
// TRANSPORT CHOICE — this client deliberately shares `telegramClientOptions`,
// i.e. the SAME IPv4-pinned keep-alive agent that the proven media-staging
// uploader (server/routes/mediaUploadRoutes.js) and all normal bot traffic use.
// A previous design gave media edits their own keepAlive:false agent; in
// production every multipart edit through it stalled for the full 30s window
// while text edits over the shared agent returned in ~0.4s, so the dedicated
// agent was retired in favour of the one transport demonstrably good for
// multipart uploads on this host.
//
// Why sharing is SAFE with retries: on timeout the AbortController genuinely
// cancels the request, and node-fetch DESTROYS an aborted request's socket
// rather than returning it to the keep-alive pool — a retry can never inherit
// a poisoned connection, no zombie upload lingers in the pool, and total socket
// count stays bounded by the shared agent. Nothing here destroys the shared
// agent itself, so long-polling and ordinary sends are never disturbed.
//
// A separate `Telegram` instance (not bot.telegram) keeps the sent-message
// registry's awaited DB insert off the media path, mirroring the staging
// client. Built lazily so requiring this module stays side-effect-free and the
// bot token is only ever read from validated config — never logged or exposed.
let mediaEditClient = null;
function getRouteMediaEditClient() {
  if (!mediaEditClient) {
    // Required lazily to avoid a load-time dependency on telegraf/config here.
    const { Telegram } = require('telegraf');
    const config = require('../config/config');
    mediaEditClient = new Telegram(config.botToken, telegramClientOptions);
  }
  return mediaEditClient;
}

module.exports = {
  telegramIpv4Agent,
  telegramClientOptions,
  getRouteMediaEditClient,
};
