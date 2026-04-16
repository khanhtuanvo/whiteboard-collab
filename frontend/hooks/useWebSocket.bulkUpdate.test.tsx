/** @vitest-environment jsdom */

import React, { useEffect } from 'react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { useWebSocket } from './useWebSocket';

type Listener = (payload?: unknown) => void;
type Ack = (response: { ok: boolean; error?: string }) => void;

class MockSocket {
  connected = true;
  listeners = new Map<string, Listener[]>();
  emitted: Array<{ event: string; payload: unknown }> = [];
  pendingBulkAck: Ack | null = null;

  on(event: string, listener: Listener) {
    const current = this.listeners.get(event) ?? [];
    current.push(listener);
    this.listeners.set(event, current);
    return this;
  }

  off(event: string, listener: Listener) {
    const current = this.listeners.get(event) ?? [];
    this.listeners.set(
      event,
      current.filter(l => l !== listener)
    );
    return this;
  }

  emit(event: string, payload?: unknown, ack?: Ack) {
    this.emitted.push({ event, payload });
    if (event === 'elements:bulk_update' && typeof ack === 'function') {
      this.pendingBulkAck = ack;
    }
    return this;
  }

  resolveBulkAck(response: { ok: boolean; error?: string }) {
    if (!this.pendingBulkAck) {
      throw new Error('No pending bulk ack callback');
    }
    const ack = this.pendingBulkAck;
    this.pendingBulkAck = null;
    ack(response);
  }
}

const mockSocket = new MockSocket();

vi.mock('@/lib/socket', () => ({
  getSocket: () => mockSocket,
}));

const control = {
  emitBulk: (_updates: Array<{ elementId: string; properties: Record<string, unknown> }>) => Promise.resolve(),
};

function Harness() {
  const { emitBulkUpdateElements } = useWebSocket({
    boardId: 'board-1',
    userName: 'Tester',
    userColor: '#000000',
    onElementCreated: () => {},
    onElementUpdated: () => {},
    onElementDeleted: () => {},
    onSnapshot: () => {},
    onActiveUsers: () => {},
    onUserJoined: () => {},
    onUserLeft: () => {},
    onCursorUpdate: () => {},
  });

  useEffect(() => {
    control.emitBulk = emitBulkUpdateElements;
  }, [emitBulkUpdateElements]);

  return null;
}

describe('useWebSocket emitBulkUpdateElements', () => {
  beforeEach(() => {
    mockSocket.connected = true;
    mockSocket.listeners.clear();
    mockSocket.emitted = [];
    mockSocket.pendingBulkAck = null;
  });

  it('resolves when server ack returns ok=true', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => {
      root.render(<Harness />);
    });

    const updates = [{ elementId: 'e1', properties: { x: 10, y: 20 } }];
    const promise = control.emitBulk(updates);

    expect(mockSocket.emitted).toContainEqual({
      event: 'elements:bulk_update',
      payload: { boardId: 'board-1', updates },
    });

    mockSocket.resolveBulkAck({ ok: true });
    await expect(promise).resolves.toBeUndefined();

    await act(async () => {
      root.unmount();
    });
  });

  it('rejects when server ack returns ok=false', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => {
      root.render(<Harness />);
    });

    const promise = control.emitBulk([{ elementId: 'e2', properties: { x: 1, y: 2 } }]);
    mockSocket.resolveBulkAck({ ok: false, error: 'Rate limit exceeded' });

    await expect(promise).rejects.toThrow('Rate limit exceeded');

    await act(async () => {
      root.unmount();
    });
  });
});
