# Samsara: where its settings live, and how a missing video is recovered

**Read this before changing anything under Settings → Samsara, the
`samsara_settings` row, or the missing-video recovery.** The Samsara *poller*
lives in the separate `samsara-integration` repository (see
[`samsara-separation.md`](samsara-separation.md) for why); this document is the
half of that story `bot-backend` owns — the schema, the admin API, and the
contract the two services meet on.

## The configuration channel is the shared database, not an API

```
Admin panel (Settings → Samsara)
        │  PUT /api/settings/samsara
        ▼
  samsara_settings  (one row, id = 1)   ──── the SHARED PostgreSQL ────┐
        ▲                                                              │
        │  GET, for the admin view and this app's own Samsara calls    │
  bot-backend                                        samsara-integration
                                                     src/samsaraSettings.js
                                                     (30s cache; env fallback)
```

The two services already share `DATABASE_URL` and nothing else. Adding an HTTP
link between them purely to exchange settings would be a second channel to get
out of step — this row is enough. A change lands in the poller within about a
minute.

**Every value falls back to the environment, per value.** An empty column means
"inherit the environment variable this service has always read". That is why the
`SAMSARA_API_KEY` currently deployed keeps working with nothing entered in the
panel and nothing migrated, and why **no new Render environment variable is
required** by any of this.

## The API key, and why it does not use `facebookCrypto`

`lib/security/facebookCrypto.js` is this repository's standard secret storage and
stays that for everything this app reads alone. It cannot hold the Samsara key,
because the **other** reader is a separate Render service that has neither
`FACEBOOK_TOKEN_ENCRYPTION_KEY` nor `JWT_SECRET`. Giving it either would be
exactly the new environment variable the operator asked to avoid — and would put
this app's session-signing secret on a second service.

So `lib/security/sharedIntegrationCrypto.js` uses the **same** AES-256-GCM
envelope (`iv.tag.ciphertext`, base64url) with different key material:

1. `INTEGRATION_SECRET_KEY`, when both services are given the same value.
   Optional; setting it is a strict upgrade.
2. Otherwise the **`DATABASE_URL` credentials** — user, password and database
   name, with **host and port deliberately excluded**. Render hands out an
   internal and an external connection string for the same database, differing
   only in host; a key that changed between them would leave the poller unable
   to read what the panel had just written.

**What that protects and what it does not.** It protects a stolen table, a
backup, a logged query result — the realistic exposures for a value sitting in a
shared Postgres. It does not protect against someone who already holds the
connection string. That is a real limit, it is why option 1 exists, and it is
still strictly better than the plaintext column the alternative would be.

Three consequences worth keeping:

- `api_key_fingerprint` records **which** key material wrote a value, so a
  reader that cannot open one distinguishes "written under a different key" from
  "corrupt", says so in the log — never printing the key or the ciphertext — and
  falls back to its environment variable rather than losing Samsara.
- `api_key_last4` exists so the panel can mask a key **it could not decrypt**,
  rather than claiming none is set.
- A save that does not include a key **leaves the stored one alone**. Tuning the
  recovery settings must never be able to wipe the working credential.

`tests/sharedIntegrationCrypto.test.js` here and
`tests/samsaraSharedIntegrationCrypto.test.js` in `samsara-integration` pin the
**same fixed vector**. If a change to one repository's derivation does not reach
the other, one of the two suites fails instead of the poller silently losing its
key in production.

## Missing-video recovery

**The alert is never delayed for video.** A safety event whose dashcam clip has
not finished uploading is sent immediately, text-only. That is the invariant
everything below serves.

```
safety event, no clip yet
   → alert sent (notifications group + subscribers + matched driver group)
   → INSERT samsara_video_recovery_jobs   (samsara_event_id UNIQUE,
                                           ON CONFLICT DO NOTHING)
   → after video_recovery_initial_delay_seconds (default 300):
         re-read the event  ─ found? ─→ fold in, completed
             │ no
         check an existing retrieval / the camera's media listing
             │ nothing
         request retrieval ONCE, store its id
             │
         …every video_recovery_retry_interval_seconds, up to
           video_recovery_max_attempts, then no_video (with the reason)
```

Three bugs this replaced, each of which must stay fixed:

1. **The wait was in-memory** (`setTimeout` + a `Set`). A restart or redeploy
   inside the window dropped every pending video — and because the text alert
   had already been delivered, nothing looked broken. The queue is now a table.
2. **The retrieval window could be zero-length.** Both paths built it as
   `start = event.startMs || event.time` and `end = event.endMs || event.time`,
   so an event reporting a single instant — most of them — asked Samsara for
   footage from T to T, which it cannot produce. The window is now anchored on
   the event and padded (`video_retrieval_window_before/after_seconds`), with a
   floor and a ceiling so it is never empty and never asks a truck to upload ten
   minutes of video.
3. **Every retry started a new retrieval job**, because nothing kept the id of
   the one already running. `retrieval_id` is persisted; a job that has one polls
   *that* request.

**Telegram behaviour is unchanged**, and it is the safe order: send the video
with the original caption first, delete the text-only message **only** after the
send succeeds. A failed send therefore never loses the alert. Destinations a
send could not reach stay on the job, so a retry goes only where the video is
still missing — a group that already has it can never receive a second copy.

### What this repository owns

| Piece | Where |
|---|---|
| The schema for both tables | `database/migrations/0013_samsara_settings_and_video_recovery.sql` |
| Reading/writing the settings row | `database/samsaraSettings.js` |
| Reading the recovery queue (admin only, **read-only**) | `database/samsaraVideoRecovery.js` |
| The admin API | `server/routes/settings/samsaraRoutes.js` |
| The screen | `admin/src/pages/settings/SamsaraTab.jsx` + `settings/samsara/*` |

**`database/samsaraVideoRecovery.js` never writes a job, on purpose.** Two
processes racing to advance one recovery is the bug the durable table exists to
prevent, and the poller is the one holding the Samsara credential and the
Telegram bots. It also selects neither `raw_event` nor `targets`: they are large,
they are the worker's business, and neither belongs in an HTTP response.

### The music overlay is unchanged

Settings → Samsara renders the existing driver-group music component
(`admin/src/pages/settings/SafetyEventsTab.jsx`) as a section, and it still talks
to its own `/api/settings/safety-events*` endpoints and its own tables. Uploaded
clips, volume, fades, original-audio mixing, the maximum processed length and
the driver-group-only rule all behave exactly as before — the tab was folded in
so an administrator sees Samsara as one integration, not rewritten.

## Tests that guard this

| Area | Test |
|---|---|
| The shared envelope, both repositories, one fixed vector | `tests/sharedIntegrationCrypto.test.js` |
| Env fallback, masking, "a save without a key keeps the key" | `tests/samsaraSettings.test.js` |
| Migration 0013, the CHECK bounds, the UNIQUE event id, the read layer | `tests/samsaraSettingsPg.test.js` |
| The poller's settings reader and its fallbacks | `samsara-integration/tests/samsaraSettings.test.js` |
| Starting a recovery, and not starting a second one | `samsara-integration/tests/samsaraVideoRecovery.test.js` |
| The whole recovery step machine | `samsara-integration/tests/samsaraVideoRecoveryWorker.test.js` |
| The store's SQL contract (idempotent enqueue, exclusive claim) | `samsara-integration/tests/samsaraVideoRecoveryStore.test.js` |
| A genuinely non-zero retrieval window | `samsara-integration/tests/samsaraVideoRetryDelivery.test.js` |
