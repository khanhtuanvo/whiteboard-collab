import logging
import logging.config
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from app.routers import clustering
from app.routers.clustering import clustering_service, limiter

load_dotenv()

LOGGING_CONFIG = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "default": {
            "format": "%(asctime)s [%(levelname)s] %(name)s: %(message)s",
            "datefmt": "%Y-%m-%dT%H:%M:%S",
        }
    },
    "handlers": {
        "console": {
            "class": "logging.StreamHandler",
            "formatter": "default",
        }
    },
    "root": {"handlers": ["console"], "level": "INFO"},
}

logging.config.dictConfig(LOGGING_CONFIG)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: validate the ML model loaded correctly
    if not clustering_service.is_ready:
        logger.critical("ML model failed to load — service will not serve requests")
        raise RuntimeError("ML model is not ready")
    logger.info("ML service startup complete — model is ready")
    yield
    logger.info("ML service shutting down")


app = FastAPI(title="Whiteboard ML Service", lifespan=lifespan)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

app.include_router(clustering.router)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/ready")
def ready():
    """Readiness probe: confirms the ML model is loaded and serving."""
    if not clustering_service.is_ready:
        return JSONResponse(status_code=503, content={"status": "not ready"})
    return {"status": "ready"}
