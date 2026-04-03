"""
Unit tests for the clustering endpoint.

The EmbeddingService and ClusteringService are mocked so the tests run
without downloading the sentence-transformers model.
"""
import os
from unittest.mock import MagicMock, patch

import numpy as np
import pytest
from fastapi.testclient import TestClient

# Set required env vars before importing the app
os.environ.setdefault("ML_SERVICE_KEY", "test-key")
os.environ.setdefault("CANVAS_WIDTH", "2000")
os.environ.setdefault("CANVAS_HEIGHT", "1500")


def _make_embeddings(texts: list[str]) -> np.ndarray:
    """Return deterministic dummy embeddings (one per text)."""
    rng = np.random.default_rng(seed=42)
    return rng.random((len(texts), 384)).astype(np.float32)


@pytest.fixture()
def client():
    mock_embedding_svc = MagicMock()
    mock_embedding_svc.is_ready = True
    mock_embedding_svc.embed.side_effect = _make_embeddings

    mock_clustering_svc = MagicMock()
    mock_clustering_svc.is_ready = True

    # Delegate to the real cluster() logic via a partial — easier: just let the
    # real ClusteringService run with the mocked EmbeddingService injected.
    from app.services.clustering_service import ClusteringService

    real_svc = ClusteringService.__new__(ClusteringService)
    real_svc._embedding_service = mock_embedding_svc

    with (
        patch("app.routers.clustering.clustering_service", real_svc),
        patch("app.main.clustering_service", real_svc),
    ):
        from app.main import app

        yield TestClient(app, raise_server_exceptions=False)


AUTH = {"Authorization": "Bearer test-key"}


# ---------------------------------------------------------------------------
# /health and /ready
# ---------------------------------------------------------------------------

def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_ready(client):
    r = client.get("/ready")
    assert r.status_code == 200
    assert r.json() == {"status": "ready"}


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

def test_cluster_no_auth(client):
    notes = [{"id": str(i), "text": f"note {i}", "x": 0.0, "y": 0.0} for i in range(5)]
    r = client.post("/cluster", json={"notes": notes})
    assert r.status_code == 403  # missing bearer token


def test_cluster_wrong_token(client):
    notes = [{"id": str(i), "text": f"note {i}", "x": 0.0, "y": 0.0} for i in range(5)]
    r = client.post("/cluster", json={"notes": notes}, headers={"Authorization": "Bearer wrong"})
    assert r.status_code == 401


# ---------------------------------------------------------------------------
# Input validation
# ---------------------------------------------------------------------------

def test_cluster_too_few_notes(client):
    notes = [{"id": str(i), "text": f"note {i}", "x": 0.0, "y": 0.0} for i in range(2)]
    r = client.post("/cluster", json={"notes": notes}, headers=AUTH)
    assert r.status_code == 400
    assert "Minimum" in r.json()["detail"]


def test_cluster_too_many_notes(client):
    notes = [{"id": str(i), "text": f"note {i}", "x": 0.0, "y": 0.0} for i in range(501)]
    r = client.post("/cluster", json={"notes": notes}, headers=AUTH)
    assert r.status_code == 400
    assert "Maximum" in r.json()["detail"]


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------

def test_cluster_minimum_notes(client):
    notes = [{"id": str(i), "text": f"note {i}", "x": float(i * 10), "y": 0.0} for i in range(3)]
    r = client.post("/cluster", json={"notes": notes}, headers=AUTH)
    assert r.status_code == 200
    result = r.json()
    assert len(result) == 3
    ids = {item["id"] for item in result}
    assert ids == {"0", "1", "2"}
    for item in result:
        assert "cluster" in item
        assert "suggestedX" in item
        assert "suggestedY" in item


def test_cluster_returns_all_note_ids(client):
    n = 10
    notes = [{"id": f"note-{i}", "text": f"sticky {i}", "x": 0.0, "y": 0.0} for i in range(n)]
    r = client.post("/cluster", json={"notes": notes}, headers=AUTH)
    assert r.status_code == 200
    result = r.json()
    assert len(result) == n
    returned_ids = {item["id"] for item in result}
    expected_ids = {f"note-{i}" for i in range(n)}
    assert returned_ids == expected_ids


def test_cluster_k_override(client):
    notes = [{"id": str(i), "text": f"note {i}", "x": 0.0, "y": 0.0} for i in range(10)]
    r = client.post("/cluster", json={"notes": notes, "k": 3}, headers=AUTH)
    assert r.status_code == 200
    clusters = {item["cluster"] for item in r.json()}
    assert len(clusters) <= 3


def test_cluster_degenerate_identical_text(client):
    """All notes have the same text — clustering should still succeed."""
    notes = [{"id": str(i), "text": "same text", "x": 0.0, "y": 0.0} for i in range(6)]
    r = client.post("/cluster", json={"notes": notes}, headers=AUTH)
    assert r.status_code == 200
    assert len(r.json()) == 6


# ---------------------------------------------------------------------------
# Fallback on clustering error
# ---------------------------------------------------------------------------

def test_cluster_fallback_on_error(client):
    """If the clustering algorithm raises, original positions are returned."""
    from app.routers import clustering as clustering_router

    original_svc = clustering_router.clustering_service
    broken_svc = MagicMock()
    broken_svc.is_ready = True
    broken_svc.cluster.side_effect = RuntimeError("model exploded")

    clustering_router.clustering_service = broken_svc
    try:
        notes = [{"id": str(i), "text": f"note {i}", "x": float(i), "y": float(i)} for i in range(5)]
        r = client.post("/cluster", json={"notes": notes}, headers=AUTH)
        assert r.status_code == 200
        result = r.json()
        assert len(result) == 5
        for item, note in zip(result, notes):
            assert item["suggestedX"] == note["x"]
            assert item["suggestedY"] == note["y"]
    finally:
        clustering_router.clustering_service = original_svc
