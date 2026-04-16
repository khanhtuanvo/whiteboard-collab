/** @vitest-environment jsdom */

import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ClusterSuggestions from './ClusterSuggestions';
import { ElementType } from '@/types/element';

const apiPost = vi.fn();

vi.mock('@/lib/api', () => ({
  default: {
    post: (...args: unknown[]) => apiPost(...args),
  },
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

const baseElements = [
  {
    id: 'n1',
    type: ElementType.STICKY_NOTE,
    properties: { text: 'A', x: 10, y: 20, width: 200, height: 200 },
  },
  {
    id: 'n2',
    type: ElementType.STICKY_NOTE,
    properties: { text: 'B', x: 30, y: 40, width: 200, height: 200 },
  },
  {
    id: 'n3',
    type: ElementType.STICKY_NOTE,
    properties: { text: 'C', x: 50, y: 60, width: 200, height: 200 },
  },
] as any;

describe('ClusterSuggestions mode payload', () => {
  beforeEach(() => {
    apiPost.mockReset();
    apiPost.mockResolvedValue({ data: [] });
  });

  it('sends aggressive mode options to the backend', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ClusterSuggestions
          boardId="board-1"
          elements={baseElements}
          onApplySuggestions={() => {}}
        />
      );
    });

    const modeSelect = container.querySelector('select');
    expect(modeSelect).toBeTruthy();

    await act(async () => {
      modeSelect!.value = 'aggressive';
      modeSelect!.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const actionButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Auto-Organize')
    );

    expect(actionButton).toBeTruthy();

    await act(async () => {
      actionButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(apiPost).toHaveBeenCalledTimes(1);
    const [, payload] = apiPost.mock.calls[0];

    expect(payload.options.layoutMode).toBe('aggressive');
    expect(payload.options.alpha).toBe(1);
    expect(payload.options.maxDisplacement).toBe(2000);

    await act(async () => {
      root.unmount();
    });
  });

  it('sends preserve mode options without hardcoded alpha/maxDisplacement', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ClusterSuggestions
          boardId="board-1"
          elements={baseElements}
          onApplySuggestions={() => {}}
        />
      );
    });

    const actionButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Auto-Organize')
    );

    expect(actionButton).toBeTruthy();

    await act(async () => {
      actionButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(apiPost).toHaveBeenCalledTimes(1);
    const [, payload] = apiPost.mock.calls[0];

    expect(payload.options.layoutMode).toBe('preserve');
    expect(payload.options.alpha).toBeUndefined();
    expect(payload.options.maxDisplacement).toBeUndefined();
    expect(payload.options.noteWidth).toBe(200);
    expect(payload.options.noteHeight).toBe(200);

    await act(async () => {
      root.unmount();
    });
  });
});
