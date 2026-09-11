'use strict';

/**
 * Is the leads bot still alive?
 *
 * The leads bot is a Python CHILD PROCESS, not a timer, so it has no pass to
 * wrap. `index.js` told the run ledger about its LIFECYCLE — it started, it
 * crashed, it was switched off — and nothing else. A child that starts once and
 * then runs healthily for a day therefore reported nothing for a day, and the
 * ledger, which expects a pass an hour from every catalogued worker, called it
 * `stale_stopped`. In production it read "no pass has finished in 269 minutes"
 * while the process was up and answering webhooks the whole time.
 *
 * A lifecycle event is not a heartbeat. This is the heartbeat: ask the child
 * the question directly, on its own HTTP health route
 * (`leads-bot/webhook_server.py` → `GET /health`), and record the answer.
 *
 * WHY AN HTTP PROBE RATHER THAN `child.exitCode === null`. A process can be
 * alive and wedged — uvicorn up, event loop blocked, webhooks timing out — and
 * the PID says nothing about that. The health route is served by the same
 * event loop that serves Facebook and RingCentral, so an answer from it is
 * evidence about the thing that actually matters.
 *
 * It OBSERVES. It never restarts the child, never kills it, and never touches
 * the supervisor's state: `index.js` owns the child's life, this module owns
 * what the ledger is told about it. A probe that failed and then restarted a
 * healthy-but-slow process would be a worse outage than a stale ledger row.
 */
const { withRunRecord } = require('./operations/runLedger');

const SERVICE_KEY = 'leads_bot';
/** Well inside the catalogue's one-hour expectation, cheap on a loopback. */
const PROBE_INTERVAL_MS = 10 * 60 * 1000;
/** The child binds its port a moment after it starts; do not race it. */
const FIRST_PROBE_DELAY_MS = 60 * 1000;
const PROBE_TIMEOUT_MS = 5_000;

let timer = null;
let probeRunning = false;

/** `http://127.0.0.1:<port>/health` — loopback only; never a public URL. */
function healthUrl(port) {
  return `http://127.0.0.1:${port}/health`;
}

/**
 * One probe. Returns a ledger SUMMARY, never throws:
 *   `{ ok: true }`        the child answered 200
 *   `{ error: … }`        it answered something else, or nothing at all
 *
 * The error sentence names the status or the error CODE, never a URL or a
 * body — `/api/health` is public and this reason is published there.
 */
async function probeOnce({ port, fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl(healthUrl(port), {
      method: 'GET',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (response?.ok) return { ok: true, status: response.status };
    return { error: `the leads bot answered its health check with ${response?.status ?? 'no status'}` };
  } catch (err) {
    const code = err?.name === 'TimeoutError' || err?.name === 'AbortError'
      ? 'a timeout'
      : (err?.cause?.code || err?.code || 'no answer');
    return { error: `the leads bot did not answer its health check (${code})` };
  }
}

/**
 * @param {object} options
 * @param {number} options.port   the child's HTTP port (`LEADS_BOT_PORT`)
 * @param {Function} [options.fetchImpl]  injected for tests
 * @param {Function} [options.record]  the ledger writer; injected for tests so
 *   the timer can be exercised without a database behind it
 */
function startLeadsBotLiveness({ port, fetchImpl, record = withRunRecord } = {}) {
  stopLeadsBotLiveness();
  const probePort = Number(port);
  if (!Number.isFinite(probePort) || probePort <= 0) return;

  const tick = async () => {
    // SINGLE FLIGHT. A probe that hangs to its timeout must not have a second
    // one stacked behind it opening a run record the first will close.
    if (probeRunning) return;
    probeRunning = true;
    try {
      await record(SERVICE_KEY, () => probeOnce({ port: probePort, fetchImpl }));
    } catch (_) {
      // withRunRecord re-throws what the pass threw; `probeOnce` throws
      // nothing, so this is belt and braces around the ledger itself.
    } finally {
      probeRunning = false;
    }
  };

  const first = setTimeout(() => {
    void tick();
    timer = setInterval(() => { void tick(); }, PROBE_INTERVAL_MS);
    timer.unref?.();
  }, FIRST_PROBE_DELAY_MS);
  first.unref?.();
  timer = first;
}

function stopLeadsBotLiveness() {
  if (!timer) return;
  clearTimeout(timer);
  clearInterval(timer);
  timer = null;
}

module.exports = {
  startLeadsBotLiveness,
  stopLeadsBotLiveness,
  probeOnce,
  PROBE_INTERVAL_MS,
  FIRST_PROBE_DELAY_MS,
};
