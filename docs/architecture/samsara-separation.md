# Samsara separation — why the poller is not in this process

**Status: done.** The Samsara camera-alert feature lives in its own repository
(`github.com/Khomurod/samsara-integration`) and runs as its own Render service.
It was fully removed from `bot-backend`.

This document exists to stop it being added back. The button-by-button migration
steps that were used once, in 2026, have been retired — they are in git history
if anyone ever needs them.

## The decision: do not re-add the Samsara poller to this process

`bot-backend` runs on Render's free plan: **512 MB for everything**. It was
starting three programs inside that one box:

| Program | Roughly |
|---|---|
| Main hub (bot + API + schedulers) | ~256 MB, its set limit |
| **Samsara poller, spawned as a child of `index.js`** | **~40 MB heap plus process overhead** |
| Leads bot (Python) | its own chunk |

That combination hit the ceiling and Render OOM-killed the service. `render.yaml`
still carries the notes from that period — the main app's limit was cut from
300 MB to 256 MB with memory-saving flags specifically to make room for "the
spawned samsara (Node child)".

Removing the child process was the single most effective fix. **Do not
reintroduce `startSamsaraBot` or any equivalent child process here.**

## What stayed, and must keep working

The main app still uses Samsara for a **different, much smaller thing**: looking
up a truck's live GPS location (city/state) for the dispatch, fuel and location
features. That is not the camera-alert poller, was never the memory problem, and
must not be removed while cleaning up Samsara references.

## How the two services still work together

They never call each other. They share two things:

1. **The same `DATABASE_URL`.** The Samsara service resolves "which driver group
   belongs to truck #123?" from the shared `groups` table. It also owns its own
   `samsara_*` tables and writes `safety_event_video_jobs`; `bot-backend` remains
   the canonical owner of the `safety_event_*` music/settings tables.
2. **The same Telegram bot tokens**, so messages still come from the same bots.

Given those two, both behaviors are preserved: safety/camera events go to the
Samsara notifications group, and the video with its caption goes to the correct
drivers group.

**The operating rule:** the separate service must be given the *same* database
URL and the *same* bot tokens as this app.

## If the old copy is still running

Two Telegram pollers on one token produce `409 Conflict`. Only one copy of the
Samsara service may run at a time — stop or suspend the old one.

## Secrets

The separate service needs the same secrets this app holds. Set them as
environment variables in its own Render dashboard. Never commit them, and never
paste a token into a document, a commit message, or chat.
