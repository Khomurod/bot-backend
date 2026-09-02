"""
Persistent files this service keeps on disk: the Messenger sender-dedupe set
and the lead log.

BOTH ARE BEST-EFFORT. Every read and write is wrapped, because losing the
dedupe file must degrade to "greet this sender again", never to a crash that
takes the webhook down — a webhook that 500s makes Meta retry and eventually
disable the subscription.

The dedupe set is an OrderedDict used as an LRU and capped at MAX_SEEN, so a
long-running instance cannot grow it without bound. It owns `_seen_senders`;
nothing outside this module rebinds it.

Split out of leads-bot/webhook_server.py.
"""
import json
import logging
import time
from collections import OrderedDict
from pathlib import Path

logger = logging.getLogger(__name__)

# ── Data directory for persistent files ──────────────────────
DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DATA_DIR.mkdir(exist_ok=True)

LEADS_LOG_FILE = DATA_DIR / "leads_log.json"
SEEN_SENDERS_FILE = DATA_DIR / "seen_senders.json"

# File-backed OrderedDict — survives restarts.
MAX_SEEN = 5000
_seen_senders: OrderedDict[str, bool] = OrderedDict()


def _load_seen_senders():
    """Load seen senders from disk on startup."""
    global _seen_senders
    try:
        if SEEN_SENDERS_FILE.exists():
            data = json.loads(SEEN_SENDERS_FILE.read_text())
            _seen_senders = OrderedDict((k, True) for k in data[-MAX_SEEN:])
            logger.info("Loaded %d seen senders from disk.", len(_seen_senders))
    except Exception as exc:
        logger.warning("Could not load seen senders (will start fresh): %s", exc)


def _save_seen_senders():
    """Persist seen senders to disk."""
    try:
        SEEN_SENDERS_FILE.write_text(json.dumps(list(_seen_senders.keys())))
    except Exception as exc:
        logger.warning("Could not save seen senders: %s", exc)


def _is_new_sender(sender_id: str) -> bool:
    """Return True if this sender hasn't messaged before (first contact)."""
    if sender_id in _seen_senders:
        _seen_senders.move_to_end(sender_id)
        return False
    _seen_senders[sender_id] = True
    while len(_seen_senders) > MAX_SEEN:
        _seen_senders.popitem(last=False)
    _save_seen_senders()
    return True


# ── Leads log: persistent record of every lead received ──────
def _log_lead(leadgen_id: str, status: str, detail: str = ""):
    """Append a lead entry to the persistent log file."""
    try:
        entries = []
        if LEADS_LOG_FILE.exists():
            try:
                entries = json.loads(LEADS_LOG_FILE.read_text())
            except Exception:
                entries = []
        entries.append({
            "leadgen_id": leadgen_id,
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "status": status,
            "detail": detail,
        })
        # Keep last 5000 entries to prevent unbounded growth
        if len(entries) > 5000:
            entries = entries[-5000:]
        LEADS_LOG_FILE.write_text(json.dumps(entries, indent=2))
    except Exception as exc:
        logger.warning("Could not write leads log: %s", exc)


def _read_leads_log() -> list:
    """The lead log as a list, or [] when it is missing or unreadable."""
    try:
        if LEADS_LOG_FILE.exists():
            return json.loads(LEADS_LOG_FILE.read_text())
    except Exception as exc:
        logger.warning("Could not read leads log: %s", exc)
    return []
