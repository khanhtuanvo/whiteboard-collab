from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List
from app.services.clustering_service import ClusteringService

router = APIRouter()
clustering_service = ClusteringService()


class StickyNoteInput(BaseModel):
    id: str
    text: str
    x: float
    y: float


class ClusterResult(BaseModel):
    id: str
    cluster: int
    suggestedX: float
    suggestedY: float


@router.post("/cluster", response_model=List[ClusterResult])
async def cluster_notes(notes: List[StickyNoteInput]):
    if len(notes) < 3:
        raise HTTPException(status_code=400, detail="Minimum 3 sticky notes required")
    return clustering_service.cluster(notes)
