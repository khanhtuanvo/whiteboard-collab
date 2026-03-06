import math
from sklearn.cluster import KMeans
from app.services.embedding_service import EmbeddingService

CANVAS_WIDTH = 2000
CANVAS_HEIGHT = 1500
NOTE_WIDTH = 200
NOTE_HEIGHT = 150
NOTE_GAP = 20


class ClusteringService:
    def __init__(self):
        self._embedding_service = EmbeddingService()

    def cluster(self, notes):
        n = len(notes)
        k = math.ceil(math.sqrt(n / 2))
        k = max(2, min(k, n))

        texts = [note.text or "(empty)" for note in notes]
        embeddings = self._embedding_service.embed(texts)

        kmeans = KMeans(n_clusters=k, random_state=42, n_init=10)
        labels = kmeans.fit_predict(embeddings)

        # Arrange k cluster centers in a grid across the virtual canvas
        cols = math.ceil(math.sqrt(k))
        rows = math.ceil(k / cols)

        cluster_centers: dict[int, tuple[float, float]] = {}
        for c in range(k):
            col_idx = c % cols
            row_idx = c // cols
            cx = (col_idx + 0.5) * (CANVAS_WIDTH / cols)
            cy = (row_idx + 0.5) * (CANVAS_HEIGHT / rows)
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
            grid_w = total_cols * (NOTE_WIDTH + NOTE_GAP) - NOTE_GAP
            grid_h = total_rows * (NOTE_HEIGHT + NOTE_GAP) - NOTE_GAP

            x = cx - grid_w / 2 + col_in_cluster * (NOTE_WIDTH + NOTE_GAP)
            y = cy - grid_h / 2 + row_in_cluster * (NOTE_HEIGHT + NOTE_GAP)

            results.append(
                {
                    "id": note.id,
                    "cluster": c,
                    "suggestedX": round(x),
                    "suggestedY": round(y),
                }
            )

        return results
