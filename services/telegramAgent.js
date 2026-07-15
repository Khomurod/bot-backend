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

// ─── Dedicated agent for Route Control media EDITS (editMessageMedia) ───
//
// Route Control replaces/converts a driver-group message's photo by uploading a
// fresh multipart body. A transient `socket hang up` (ECONNRESET) mid-upload is
// retried — but a retry must NOT reuse a possibly half-dead pooled socket.
//
// This agent pins IPv4 (same upload-stall fix as above) but disables keep-alive,
// so EVERY media-edit request (and each retry) opens a brand-new connection.
// It is SEPARATE from the shared polling/agent above, so retrying a media edit
// never disturbs long-poll or ordinary bot traffic, and we never destroy a
// shared agent. `maxSockets` is bounded to avoid unbounded socket growth even
// though media edits are rare, admin-triggered actions.
const telegramMediaEditAgent = new https.Agent({
  keepAlive: false,
  family: 4,
  maxSockets: 4,
});

// Lazily-built dedicated Telegraf `Telegram` client for Route Control media
// edits, bound to the fresh-socket agent. Lazy so requiring this module stays
// side-effect-free (no client until a media edit actually happens) and so the
// bot token is only read from validated config, never logged or exposed.
let mediaEditClient = null;
function getRouteMediaEditClient() {
  if (!mediaEditClient) {
    // Required lazily to avoid a load-time dependency on telegraf/config here.
    const { Telegram } = require('telegraf');
    const config = require('../config/config');
    mediaEditClient = new Telegram(config.botToken, {
      agent: telegramMediaEditAgent,
      attachmentAgent: telegramMediaEditAgent,
    });
  }
  return mediaEditClient;
}

module.exports = {
  telegramIpv4Agent,
  telegramClientOptions,
  telegramMediaEditAgent,
  getRouteMediaEditClient,
};
