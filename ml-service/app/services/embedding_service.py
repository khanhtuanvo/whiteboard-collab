import numpy as np
from sentence_transformers import SentenceTransformer


class EmbeddingService:
    def __init__(self):
        # all-MiniLM-L6-v2: small, fast, strong for semantic similarity
        self._model = SentenceTransformer("all-MiniLM-L6-v2")

    def embed(self, texts: list[str]) -> np.ndarray:
        return self._model.encode(texts, convert_to_numpy=True)
