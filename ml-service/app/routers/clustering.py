import asyncio
import logging
import os
import time
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel, Field
from slowapi import Limiter
from slowapi.util import get_remote_address

from app.services.clustering_service import ClusteringService

logger = logging.getLogger(__name__)

router = APIRouter()
security = HTTPBearer()
limiter = Limiter(key_func=get_remote_address)

# Singleton — model is loaded once at startup
clustering_service = ClusteringService()


def verify_token(credentials: HTTPAuthorizationCredentials = Depends(security)):
    expected = os.environ.get("ML_SERVICE_KEY")
    if not expected or credentials.credentials != expected:
        raise HTTPException(status_code=401, detail="Unauthorized")


class StickyNoteInput(BaseModel):
    id: str
    text: str = Field(max_length=1000)
    x: float
    y: float


class ClusterRequest(BaseModel):
    notes: List[StickyNoteInput]
    k: Optional[int] = Field(None, ge=2, le=50, description="Override number of clusters (auto-computed if omitted)")


class ClusterResult(BaseModel):
    id: str
    cluster: int
    suggestedX: float
    suggestedY: float


@router.post("/cluster", response_model=List[ClusterResult])
@limiter.limit("20/minute")
async def cluster_notes(
    request: Request,
    body: ClusterRequest,
    _: None = Depends(verify_token),
):
    notes = body.notes
    k = body.k

    if len(notes) < 3:
        raise HTTPException(status_code=400, detail="Minimum 3 sticky notes required")
    if len(notes) > 500:
        raise HTTPException(status_code=400, detail="Maximum 500 sticky notes allowed")

    logger.info(
        "Cluster request: %d notes, k_override=%s, remote=%s",
        len(notes),
        k,
        request.client.host if request.client else "unknown",
    )

    start = time.perf_counter()
    try:
        # Run CPU-bound work in a thread pool so the event loop stays unblocked
        results = await asyncio.to_thread(clustering_service.cluster, notes, k)
    except Exception:
        logger.exception("Clustering failed — returning original positions as fallback")
        results = [
            {"id": n.id, "cluster": 0, "suggestedX": n.x, "suggestedY": n.y}
            for n in notes
        ]

    elapsed_ms = (time.perf_counter() - start) * 1000
    logger.info("Cluster request completed in %.1f ms", elapsed_ms)
    return results
