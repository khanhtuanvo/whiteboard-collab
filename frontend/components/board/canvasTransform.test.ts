import { describe, expect, it } from 'vitest';
import { buildTransformUpdates, normalizeScale, resolveSyncBaseDimensions } from './canvasTransform';

describe('buildTransformUpdates', () => {
  it('keeps width/height as raw base dimensions while applying scale', () => {
    const original = {
      x: 40,
      y: 50,
      width: 240,
      height: 120,
      scaleX: 1,
      scaleY: 1,
      fill: '#f59e0b',
    };

    const updates = buildTransformUpdates(original, {
      absLeft: 40,
      absTop: 50,
      width: 240,
      height: 120,
      scaleX: 0.15,
      scaleY: 0.2,
    });

    expect(updates.width).toBe(240);
    expect(updates.height).toBe(120);
    expect(updates.scaleX).toBe(0.15);
    expect(updates.scaleY).toBe(0.2);
  });

  it('shifts x2/y2 by the same movement delta for line-like elements', () => {
    const original = {
      x: 100,
      y: 80,
      x2: 160,
      y2: 120,
      stroke: '#000000',
      strokeWidth: 2,
    };

    const updates = buildTransformUpdates(original, {
      absLeft: 130,
      absTop: 95,
      width: 60,
      height: 40,
      scaleX: 1,
      scaleY: 1,
    });

    expect(updates.x).toBe(130);
    expect(updates.y).toBe(95);
    expect(updates.x2).toBe(190);
    expect(updates.y2).toBe(135);
  });

  it('keeps sticky note sync width/height as raw base values even at minimized scale', () => {
    const dims = resolveSyncBaseDimensions({
      width: 200,
      height: 160,
      currentWidth: 200,
      currentHeight: 160,
    });

    // Regression: sync must not divide by scale (e.g. 0.2) and inflate to 1000.
    expect(dims.width).toBe(200);
    expect(dims.height).toBe(160);
  });

  it('falls back to current dimensions when sync payload omits width/height', () => {
    const dims = resolveSyncBaseDimensions({
      currentWidth: 320,
      currentHeight: 180,
    });

    expect(dims.width).toBe(320);
    expect(dims.height).toBe(180);
  });

  it('clamps non-positive sync dimensions to a safe minimum', () => {
    const dims = resolveSyncBaseDimensions({
      width: 0,
      height: -20,
      currentWidth: 0,
      currentHeight: 0,
    });

    expect(dims.width).toBeGreaterThan(0);
    expect(dims.height).toBeGreaterThan(0);
  });

  it('normalizes zero/invalid scale to a safe positive value', () => {
    expect(normalizeScale(0, 1)).toBeGreaterThan(0);
    expect(normalizeScale(-1, 1)).toBeGreaterThan(0);
    expect(normalizeScale(Number.NaN, 1)).toBeGreaterThan(0);
  });
});
