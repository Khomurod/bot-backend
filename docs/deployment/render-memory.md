# Render free-tier memory guide (512MB instance)

The main hub runs on a 512MB Render instance with the Node heap capped at
`--max-old-space-size=256` (see `render.yaml`) and `MALLOC_ARENA_MAX=2` to limit
native-heap fragmentation. The Python leads-bot child shares the same instance,
so the Node process must stay well under the cap.

## Measured footprint

Profiled with `node --expose-gc` on the full boot module graph (bot + server +
all background services loaded, before network/DB connect):

| Stage | RSS |
|---|---|
| Node runtime baseline | ~42 MB |
| + config + database (pg) | ~55 MB |
| + Telegram bot (telegraf + services) | ~78 MB |
| + Express API (express, fleet, multer) | ~88 MB |
| **Boot total** | **~88–94 MB** |

Heavy libraries are lazy-loaded and cost nothing until first use:

- `pdf-parse` (~20 MB RSS) — loads on first PDF text extraction.
- `tesseract.js` + `eng.traineddata` — loads on first OCR.
- `pdf-lib` (~6 MB) — loads on first BOL/POD merge (`documentMergeService`).
- `openai` SDK (~3 MB) — loads on first translation (`translationService`).
- `nodemailer` — loads on first OTP email.

Runtime memory pressure therefore comes from *work*, not boot: PDF/OCR jobs,
multer uploads held in memory, AI document batches, and Telegram media buffers.

## Memory watchdog

Opt-in observability, off by default:

```
MEMORY_WATCHDOG_ENABLED=true
MEMORY_WATCHDOG_INTERVAL_MS=900000   # 15 min (floor: 60s)
MEMORY_WATCHDOG_RSS_WARN_MB=450
MEMORY_WATCHDOG_HEAP_WARN_MB=200
```

When enabled it logs one `[MEMORY] rss=…MB heapUsed=…MB …` line per interval
and escalates to a warning when RSS ≥ 450MB or heapUsed ≥ 200MB. A sustained
episode re-warns at most once per hour, so it cannot flood the logs. The
watchdog allocates nothing per tick and its timer is unref()'d.

**If RSS trends above ~450MB:** check for a stuck document batch or an unusual
upload burst first; then consider lowering `DATATRUCK_DOC_INTAKE_MAX_FILES` /
`…_MAX_FILE_MB`, and restart the service to clear fragmentation.

## Upload memory bounds

All uploads use `multer.memoryStorage()` (buffers live in RAM until handled):

Full audit of every `multer.memoryStorage()` route (all uploads are held in a
RAM buffer only for the duration of one request, then released):

| Route | File | Per-file cap | Count | Mime filter | Feature | Memory risk |
|---|---|---|---|---|---|---|
| `POST /api/upload-media` | `server/routes/mediaUploadRoutes.js` | 20 MB (photos rejected early at 10 MB) | 1 | jpg/png/webp/mp4/mov | Broadcast media staged to Telegram for a `file_id` | Low — single buffer, admin-only (JWT) |
| `POST /api/dispatch/parse-rate-con` | `server/routes/dispatchRoutes.js` | 20 MB | 1 | pdf/jpg/png/webp | Rate-con AI parse (PDF/OCR runs on the buffer) | Low/Medium — parse allocs on top of the buffer; admin-only |
| `POST /api/dispatch/send-to-telegram` | `server/routes/dispatchRoutes.js` | 20 MB | 1 | **any** (intentional — dispatchers forward arbitrary documents to driver groups) | Dispatch document forward | Low — buffer streamed straight to Telegram; admin-only |
| `POST /api/home-time/import-screenshots` | `server/routes/homeTimeRoutes.js` | 8 MB | 12 (40 MB batch cap) | jpg/png/webp | AI-vision home-time import | Low — batch-bounded since PR #91; admin-only |
| `POST /api/settings/safety-events/music` | `server/routes/settingsRoutes.js` | 20 MB (`MAX_MUSIC_BYTES`) | 1 | audio | Safety-event music overlay asset | Low — rare one-off admin upload |

Every route is JWT-protected, rejects oversize files with a clear message
before processing, and holds at most one bounded buffer per request. Worst
plausible case (a few concurrent 20 MB admin uploads) is a transient
40–60 MB spike — within the 256 MB heap budget.

> **Rule: never increase `memoryStorage` upload limits on the Render free
> tier. If larger files are required, switch that route to `diskStorage` or
> streaming FIRST** (with temp-file cleanup guaranteed on both success and
> failure paths), then raise the limit.

**Disk/streaming review (2026-07, after the PR #92 audit):** deliberately NOT
implemented. Every route above is a single bounded ≤20 MB buffer whose
consumer needs the whole file at once anyway (Telegram upload takes a
buffer/stream of the complete file; the AI/PDF parsers read the full
document; pg stores the music asset as one bytea row). Converting to
diskStorage would add temp-file lifecycle risk (orphaned files on crash
paths) for no meaningful memory win at these sizes — the behavior risk
outweighs the gain. Revisit only if a route genuinely needs >20 MB files.

## Background services

Every polling service has a re-entrancy guard (`tickRunning`) and a stop flag;
none can overlap itself or start twice. The Samsara safety-event poller runs as
a **separate Render service** (github.com/Khomurod/samsara-integration) — do
not re-add it to this instance.

The Python leads-bot (`leads-bot/`) is spawned as a child process by `index.js`
and **must stay enabled** (`ENABLE_LEADS_BOT` unset or `true`); it is part of
this deployment. It sets `MALLOC_ARENA_MAX=2` and is restart-protected by a
crash circuit breaker.

## Database pool

`PG_POOL_MAX=5` (default) — keep ≤ 5 on free-tier Postgres; the shutdown path
drains the pool with a 5s timeout.
