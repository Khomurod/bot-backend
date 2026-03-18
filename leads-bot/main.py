"""Entry point — starts uvicorn."""
import uvicorn
from config import PORT

if __name__ == "__main__":
    uvicorn.run(
        "webhook_server:app",
        host="0.0.0.0",
        port=PORT,
        log_level="info",
    )
