"""Tests for request body shape compatibility in /cluster endpoint."""

import os
from unittest.mock import MagicMock, patch

import numpy as np
import pytest
from fastapi.testclient import TestClient

os.environ.setdefault('ML_SERVICE_KEY', 'test-key')
os.environ.setdefault('CANVAS_WIDTH', '2000')
os.environ.setdefault('CANVAS_HEIGHT', '1500')


def _make_embeddings(texts: list[str]) -> np.ndarray:
    rng = np.random.default_rng(seed=123)
    return rng.random((len(texts), 384)).astype(np.float32)


@pytest.fixture()
def client():
    mock_embedding_svc = MagicMock()
    mock_embedding_svc.is_ready = True
    mock_embedding_svc.embed.side_effect = _make_embeddings

    from app.services.clustering_service import ClusteringService

    real_svc = ClusteringService.__new__(ClusteringService)
    real_svc._embedding_service = mock_embedding_svc

    with (
        patch('app.routers.clustering.clustering_service', real_svc),
        patch('app.main.clustering_service', real_svc),
    ):
        from app.main import app

        yield TestClient(app, raise_server_exceptions=False)


AUTH = {'Authorization': 'Bearer test-key'}


def test_cluster_accepts_wrapped_notes_object(client):
    notes = [
        {'id': 'n1', 'text': 'Login flow', 'x': 0.0, 'y': 0.0},
        {'id': 'n2', 'text': 'Auth bug', 'x': 10.0, 'y': 10.0},
        {'id': 'n3', 'text': 'Session timeout', 'x': 20.0, 'y': 20.0},
    ]

    response = client.post('/cluster', json={'notes': notes}, headers=AUTH)

    assert response.status_code == 200
    result = response.json()
    assert len(result) == 3
    assert {item['id'] for item in result} == {'n1', 'n2', 'n3'}


def test_cluster_accepts_wrapped_options_object(client):
    notes = [
        {'id': 'n1', 'text': 'Login flow', 'x': 0.0, 'y': 0.0, 'width': 200, 'height': 200},
        {'id': 'n2', 'text': 'Auth bug', 'x': 150.0, 'y': 100.0, 'width': 200, 'height': 200},
        {'id': 'n3', 'text': 'Session timeout', 'x': 300.0, 'y': 200.0, 'width': 200, 'height': 200},
    ]

    response = client.post(
        '/cluster',
        json={
            'notes': notes,
            'options': {
                'layoutMode': 'preserve',
                'alpha': 0.35,
                'maxDisplacement': 400,
                'noteWidth': 200,
                'noteHeight': 200,
            },
        },
        headers=AUTH,
    )

    assert response.status_code == 200
    result = response.json()
    assert len(result) == 3
    assert {item['id'] for item in result} == {'n1', 'n2', 'n3'}


def test_cluster_accepts_legacy_array_payload(client):
    notes = [
        {'id': 'n1', 'text': 'Login flow', 'x': 0.0, 'y': 0.0},
        {'id': 'n2', 'text': 'Auth bug', 'x': 10.0, 'y': 10.0},
        {'id': 'n3', 'text': 'Session timeout', 'x': 20.0, 'y': 20.0},
    ]

    response = client.post('/cluster', json=notes, headers=AUTH)

    assert response.status_code == 200
    result = response.json()
    assert len(result) == 3
    assert {item['id'] for item in result} == {'n1', 'n2', 'n3'}


def test_cluster_legacy_array_still_validates_minimum_notes(client):
    notes = [
        {'id': 'n1', 'text': 'Only one', 'x': 0.0, 'y': 0.0},
        {'id': 'n2', 'text': 'Only two', 'x': 10.0, 'y': 10.0},
    ]

    response = client.post('/cluster', json=notes, headers=AUTH)

    assert response.status_code == 400
    assert 'Minimum 3 sticky notes required' in response.json()['detail']
