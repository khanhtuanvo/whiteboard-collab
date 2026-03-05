from fastapi import FastAPI
from app.routers import clustering

app = FastAPI(title="Whiteboard ML Service")

app.include_router(clustering.router)


@app.get("/health")
def health():
    return {"status": "ok"}
