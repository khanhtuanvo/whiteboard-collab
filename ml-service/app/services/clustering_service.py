import logging
import math
import os

from sklearn.cluster import KMeans

from app.services.embedding_service import EmbeddingService

logger = logging.getLogger(__name__)

CANVAS_WIDTH = int(os.environ.get("CANVAS_WIDTH", 2000))
CANVAS_HEIGHT = int(os.environ.get("CANVAS_HEIGHT", 1500))
NOTE_WIDTH = 200
NOTE_HEIGHT = 200
NOTE_GAP = 20
DEFAULT_ALPHA = 0.35
DEFAULT_MAX_DISPLACEMENT = 400


class ClusteringService:
    def __init__(self):
        self._embedding_service = EmbeddingService()

    @property
    def is_ready(self) -> bool:
        return self._embedding_service.is_ready

    @staticmethod
    def _clamp(value: float, lower: float, upper: float) -> float:
        return max(lower, min(value, upper))

    def _tune_preserve_defaults(self, notes) -> tuple[float, float]:
        n = len(notes)
        xs = [note.x for note in notes]
        ys = [note.y for note in notes]

        span_w = max(xs) - min(xs) if xs else 0.0
        span_h = max(ys) - min(ys) if ys else 0.0
        spread_diag = math.hypot(span_w, span_h)
        canvas_diag = math.hypot(CANVAS_WIDTH, CANVAS_HEIGHT)
        spread_ratio = self._clamp(spread_diag / canvas_diag if canvas_diag > 0 else 0.0, 0.0, 1.0)
        count_ratio = self._clamp(n / 200.0, 0.0, 1.0)

        # Denser and wider boards should move less aggressively by default.
        tuned_alpha = self._clamp(0.42 - 0.12 * spread_ratio - 0.10 * count_ratio, 0.22, 0.45)
        tuned_cap = self._clamp(300 + 180 * spread_ratio + 0.5 * n, 280, 650)
        return tuned_alpha, tuned_cap

    def cluster(self, notes, k: int | None = None, options: dict | None = None):
        n = len(notes)
        if k is None:
            k = math.ceil(math.sqrt(n / 2))
        k = max(2, min(k, n))

        options = options or {}
        layout_mode = options.get("layoutMode", "preserve")
        tuned_alpha, tuned_cap = self._tune_preserve_defaults(notes)
        alpha = float(options.get("alpha", tuned_alpha if layout_mode == "preserve" else 1.0))
        max_displacement = float(
            options.get(
                "maxDisplacement",
                tuned_cap if layout_mode == "preserve" else max(CANVAS_WIDTH, CANVAS_HEIGHT),
            )
        )
        note_width = max(1.0, float(options.get("noteWidth", NOTE_WIDTH)))
        note_height = max(1.0, float(options.get("noteHeight", NOTE_HEIGHT)))

        if layout_mode == "aggressive":
            alpha = float(options.get("alpha", 1.0))
            max_displacement = float(options.get("maxDisplacement", max(CANVAS_WIDTH, CANVAS_HEIGHT)))

        alpha = self._clamp(alpha, 0.0, 1.0)
        max_displacement = max(0.0, max_displacement)

        texts = [note.text or "(empty)" for note in notes]
        centroid_x = sum(note.x for note in notes) / n
        centroid_y = sum(note.y for note in notes) / n

        logger.info(
            "Clustering %d notes into %d clusters (mode=%s alpha=%.2f cap=%.1f tuned_alpha=%.2f tuned_cap=%.1f)",
            n,
            k,
            layout_mode,
            alpha,
            max_displacement,
            tuned_alpha,
            tuned_cap,
        )

        embeddings = self._embedding_service.embed(texts)

        kmeans = KMeans(n_clusters=k, random_state=42, n_init=10)
        labels = kmeans.fit_predict(embeddings)

        # Arrange cluster centers around current board centroid to preserve locality.
        cols = math.ceil(math.sqrt(k))
        rows = math.ceil(k / cols)
        cluster_spacing_x = max(note_width * 2.5, 320)
        cluster_spacing_y = max(note_height * 2.2, 280)

        cluster_centers: dict[int, tuple[float, float]] = {}
        for c in range(k):
            col_idx = c % cols
            row_idx = c // cols
            center_col = (cols - 1) / 2.0
            center_row = (rows - 1) / 2.0
            cx = centroid_x + (col_idx - center_col) * cluster_spacing_x
            cy = centroid_y + (row_idx - center_row) * cluster_spacing_y
            cluster_centers[c] = (cx, cy)

        # Pre-compute cluster sizes so we can centre the note grid
        cluster_sizes: dict[int, int] = {}
        for label in labels:
            c = int(label)
            cluster_sizes[c] = cluster_sizes.get(c, 0) + 1

        cluster_note_idx: dict[int, int] = {}
        results = []

        for note, label in zip(notes, labels):
            c = int(label)
            idx = cluster_note_idx.get(c, 0)
            cluster_note_idx[c] = idx + 1

            size = cluster_sizes[c]
            total_cols = max(1, math.ceil(math.sqrt(size)))
            total_rows = math.ceil(size / total_cols)

            col_in_cluster = idx % total_cols
            row_in_cluster = idx // total_cols

            cx, cy = cluster_centers[c]
            grid_w = total_cols * (note_width + NOTE_GAP) - NOTE_GAP
            grid_h = total_rows * (note_height + NOTE_GAP) - NOTE_GAP

            target_x = cx - grid_w / 2 + col_in_cluster * (note_width + NOTE_GAP)
            target_y = cy - grid_h / 2 + row_in_cluster * (note_height + NOTE_GAP)

            blended_x = (1 - alpha) * note.x + alpha * target_x
            blended_y = (1 - alpha) * note.y + alpha * target_y

            dx = self._clamp(blended_x - note.x, -max_displacement, max_displacement)
            dy = self._clamp(blended_y - note.y, -max_displacement, max_displacement)
            x = note.x + dx
            y = note.y + dy

            results.append(
                {
                    "id": note.id,
                    "cluster": c,
                    "suggestedX": round(x),
                    "suggestedY": round(y),
                }
            )

        logger.info("Clustering complete: %d notes assigned to %d clusters", n, k)
        return results
