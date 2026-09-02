"""
The leads webhook server, split by responsibility.

webhook_server.py stays the module uvicorn starts ("webhook_server:app") and
holds the FastAPI app, its routes and lifecycle. Everything a route delegates
to lives here:

    state.py             persistent files: the sender-dedupe set and lead log
    meta_signature.py    X-Hub-Signature-256 verification (FAIL-CLOSED)
    hub_client.py        calls into the Node hub (queue ingest, retry)
    telegram_client.py   every Telegram Bot API call this service makes
    connect_command.py   the /connect group flow and the SMS mirror replies
    ringcentral.py       inbound SMS/MMS -> Telegram forwarding

Each module owns its own mutable state and exposes functions to change it, so
no other module rebinds a global it does not own.
"""
