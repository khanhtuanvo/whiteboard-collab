import os
from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel, Field
from typing import List
from app.services.clustering_service import ClusteringService

router = APIRouter()
clustering_service = ClusteringService()
security = HTTPBearer()


def verify_token(credentials: HTTPAuthorizationCredentials = Depends(security)):
    expected = os.environ.get("ML_SERVICE_KEY")
    if not expected or credentials.credentials != expected:
        raise HTTPException(status_code=401, detail="Unauthorized")


class StickyNoteInput(BaseModel):
    id: str
    text: str = Field(max_length=1000)
    x: float
    y: float


class ClusterResult(BaseModel):
    id: str
    cluster: int
    suggestedX: float
    suggestedY: float


@router.post("/cluster", response_model=List[ClusterResult])
async def cluster_notes(notes: List[StickyNoteInput], _: None = Depends(verify_token)):
    if len(notes) < 3:
        raise HTTPException(status_code=400, detail="Minimum 3 sticky notes required")
    if len(notes) > 500:
        raise HTTPException(status_code=400, detail="Maximum 500 sticky notes allowed")
    return clustering_service.cluster(notes)
