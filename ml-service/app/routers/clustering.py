import asyncio
import logging
import os
import time
from typing import List, Literal, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel, Field
from pydantic import TypeAdapter
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
    width: Optional[float] = Field(default=200, gt=0)
    height: Optional[float] = Field(default=200, gt=0)


class ClusterOptions(BaseModel):
    layoutMode: Literal['preserve', 'aggressive'] = 'preserve'
    alpha: Optional[float] = Field(default=None, ge=0, le=1)
    maxDisplacement: Optional[float] = Field(default=None, ge=0, le=5000)
    noteWidth: float = Field(default=200, gt=0)
    noteHeight: float = Field(default=200, gt=0)


class ClusterRequest(BaseModel):
    notes: List[StickyNoteInput]
    k: Optional[int] = Field(None, ge=2, le=50, description="Override number of clusters (auto-computed if omitted)")
    options: Optional[ClusterOptions] = None


class ClusterResult(BaseModel):
    id: str
    cluster: int
    suggestedX: float
    suggestedY: float


NotesAdapter = TypeAdapter(List[StickyNoteInput])


async def _parse_cluster_request(request: Request) -> Tuple[List[StickyNoteInput], Optional[int], Optional[ClusterOptions]]:
    payload = await request.json()
    if isinstance(payload, list):
        return NotesAdapter.validate_python(payload), None, None

    body = ClusterRequest.model_validate(payload)
    return body.notes, body.k, body.options


@router.post("/cluster", response_model=List[ClusterResult])
@limiter.limit("20/minute")
async def cluster_notes(
    request: Request,
    _: None = Depends(verify_token),
):
    notes, k, options = await _parse_cluster_request(request)

    if len(notes) < 3:
        raise HTTPException(status_code=400, detail="Minimum 3 sticky notes required")
    if len(notes) > 500:
        raise HTTPException(status_code=400, detail="Maximum 500 sticky notes allowed")

    logger.info(
        "Cluster request: %d notes, k_override=%s, mode=%s, remote=%s",
        len(notes),
        k,
        options.layoutMode if options else "preserve",
        request.client.host if request.client else "unknown",
    )

    start = time.perf_counter()
    try:
        # Run CPU-bound work in a thread pool so the event loop stays unblocked
        results = await asyncio.to_thread(
            clustering_service.cluster,
            notes,
            k,
            options.model_dump(exclude_none=True) if options else None,
        )
    except Exception:
        logger.exception("Clustering failed — returning original positions as fallback")
        results = [
            {"id": n.id, "cluster": 0, "suggestedX": n.x, "suggestedY": n.y}
            for n in notes
        ]

    elapsed_ms = (time.perf_counter() - start) * 1000
    logger.info("Cluster request completed in %.1f ms", elapsed_ms)
    return results
