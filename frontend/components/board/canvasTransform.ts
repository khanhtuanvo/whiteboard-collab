import { Element } from '@/types/element';

const MIN_DIMENSION = 1;
const MIN_SCALE = 0.01;

interface TransformSnapshot {
  absLeft: number;
  absTop: number;
  width: number;
  height: number;
  scaleX?: number;
  scaleY?: number;
}

/**
 * Builds the persisted element properties after a drag/resize transform.
 * Width/height are stored as raw base dimensions (never pre-multiplied by scale).
 */
export function buildTransformUpdates(
  elementProperties: Element['properties'],
  snapshot: TransformSnapshot
): Element['properties'] {
  const updates: Element['properties'] = {
    ...elementProperties,
    x: snapshot.absLeft,
    y: snapshot.absTop,
    width: sanitizeDimension(snapshot.width, elementProperties.width ?? 100),
    height: sanitizeDimension(snapshot.height, elementProperties.height ?? 100),
    scaleX: normalizeScale(snapshot.scaleX, elementProperties.scaleX ?? 1),
    scaleY: normalizeScale(snapshot.scaleY, elementProperties.scaleY ?? 1),
  };

  // LINE/ARROW endpoints are absolute; shift by the same drag delta.
  if (elementProperties.x2 !== undefined) {
    const deltaX = snapshot.absLeft - (elementProperties.x ?? 0);
    const deltaY = snapshot.absTop - (elementProperties.y ?? 0);
    updates.x2 = elementProperties.x2 + deltaX;
    updates.y2 = (elementProperties.y2 ?? 0) + deltaY;
  }

  return updates;
}

interface SyncDimensionSnapshot {
  width?: number;
  height?: number;
  currentWidth?: number;
  currentHeight?: number;
}

/**
 * Resolves next persisted base dimensions during server-sync apply.
 * Width/height from sync payload are already raw base values and must not be
 * divided by scale again.
 */
export function resolveSyncBaseDimensions(snapshot: SyncDimensionSnapshot): {
  width: number;
  height: number;
} {
  return {
    width: sanitizeDimension(snapshot.width, snapshot.currentWidth ?? 100),
    height: sanitizeDimension(snapshot.height, snapshot.currentHeight ?? 100),
  };
}

/** Keeps persisted scale values finite and non-zero to avoid zero-sized object caches in Fabric. */
export function normalizeScale(nextScale: number | undefined, fallback = 1): number {
  return sanitizeScale(nextScale, fallback);
}

function sanitizeDimension(value: number | undefined, fallback: number): number {
  const candidate = value ?? fallback;
  if (!Number.isFinite(candidate) || candidate <= 0) {
    return Math.max(MIN_DIMENSION, fallback);
  }
  return Math.max(MIN_DIMENSION, candidate);
}

function sanitizeScale(value: number | undefined, fallback: number): number {
  const candidate = value ?? fallback;
  if (!Number.isFinite(candidate) || candidate <= 0) {
    return Math.max(MIN_SCALE, fallback);
  }
  return Math.max(MIN_SCALE, candidate);
}
