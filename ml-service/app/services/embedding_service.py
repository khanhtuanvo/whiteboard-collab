import hashlib
import logging
import os
from threading import Lock

import numpy as np
from sentence_transformers import SentenceTransformer

logger = logging.getLogger(__name__)

_CACHE_MAX_SIZE = 2000


class EmbeddingService:
    def __init__(self):
        model_name = os.environ.get("EMBEDDING_MODEL", "all-MiniLM-L6-v2")
        logger.info("Loading embedding model: %s", model_name)
        try:
            self._model = SentenceTransformer(model_name)
            logger.info("Embedding model loaded successfully")
        except Exception as exc:
            logger.exception("Failed to load embedding model '%s'", model_name)
            self._model = None
            raise RuntimeError(f"Embedding model load failed: {exc}") from exc

        self._cache: dict[str, np.ndarray] = {}
        self._lock = Lock()

    @property
    def is_ready(self) -> bool:
        return self._model is not None

    def embed(self, texts: list[str]) -> np.ndarray:
        results: list[np.ndarray | None] = [None] * len(texts)
        uncached_indices: list[int] = []
        uncached_texts: list[str] = []

        for i, text in enumerate(texts):
            key = hashlib.md5(text.encode()).hexdigest()
            with self._lock:
                cached = self._cache.get(key)
            if cached is not None:
                results[i] = cached
            else:
                uncached_indices.append(i)
                uncached_texts.append(text)

        if uncached_texts:
            cache_hits = len(texts) - len(uncached_texts)
            logger.debug(
                "Embedding %d texts (%d cache hits, %d misses)",
                len(texts),
                cache_hits,
                len(uncached_texts),
            )
            new_embeddings = self._model.encode(uncached_texts, convert_to_numpy=True)
            for idx, text, vec in zip(uncached_indices, uncached_texts, new_embeddings):
                key = hashlib.md5(text.encode()).hexdigest()
                with self._lock:
                    if len(self._cache) >= _CACHE_MAX_SIZE:
                        # Evict the oldest entry (insertion-ordered dict)
                        self._cache.pop(next(iter(self._cache)))
                    self._cache[key] = vec
                results[idx] = vec

        return np.array(results)
