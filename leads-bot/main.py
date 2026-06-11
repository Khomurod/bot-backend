"""Entry point - starts uvicorn."""
import logging
import os

import uvicorn

logger = logging.getLogger(__name__)


if __name__ == "__main__":
    local_api_base_url = os.environ.get("LOCAL_API_BASE_URL", "").strip()
    if not local_api_base_url:
        logging.basicConfig(level=logging.INFO)
        logger.error(
            "LOCAL_API_BASE_URL is required and must point to the Main Hub's "
            "public HTTPS Render URL."
        )
        raise SystemExit(1)

    from config import PORT

    uvicorn.run(
        "webhook_server:app",
        host="0.0.0.0",
        port=PORT,
        log_level="info",
    )
