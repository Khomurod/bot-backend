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

| Route | Per-file cap | Batch cap |
|---|---|---|
| `POST /api/upload-media` (broadcast media) | 20 MB (photos 10 MB) | single file |
| Dispatch document routes | 20 MB | single file |
| `POST /api/home-time/import-screenshots` | 8 MB × 12 files | 40 MB total |

**Future improvement (not yet implemented):** the 20MB single-file routes are
fine in memory, but if larger videos are ever needed, switch those two routes
to `multer.diskStorage()` + streamed forwarding to Telegram instead of raising
the in-memory cap.

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
