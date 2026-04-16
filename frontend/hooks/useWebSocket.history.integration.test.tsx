/** @vitest-environment jsdom */

import React, { useEffect } from 'react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { useHistory } from './useHistory';
import { useWebSocket } from './useWebSocket';

type Listener = (payload?: unknown) => void;

class MockSocket {
  connected = false;
  listeners = new Map<string, Listener[]>();
  emitted: Array<{ event: string; payload: unknown }> = [];

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

  emit(event: string, payload?: unknown) {
    this.emitted.push({ event, payload });
    return this;
  }

  trigger(event: string, payload?: unknown) {
    const current = this.listeners.get(event) ?? [];
    for (const listener of current) listener(payload);
  }
}

const mockSocket = new MockSocket();

vi.mock('@/lib/socket', () => ({
  getSocket: () => mockSocket,
}));

const control = {
  canUndo: false,
  canRedo: false,
  undo: () => {},
  redo: () => {},
  reconnectCount: 0,
};

function Harness() {
  const history = useHistory({
    boardId: 'board-1',
    emitUndo: () => mockSocket.emit('element:undo', { boardId: 'board-1' }),
    emitRedo: () => mockSocket.emit('element:redo', { boardId: 'board-1' }),
  });

  useWebSocket({
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
    onHistoryState: history.setHistoryState,
    onReconnect: () => {
      control.reconnectCount += 1;
    },
  });

  useEffect(() => {
    control.canUndo = history.canUndo;
    control.canRedo = history.canRedo;
    control.undo = history.undo;
    control.redo = history.redo;
  }, [history.canUndo, history.canRedo, history.undo, history.redo]);

  return null;
}

describe('useWebSocket + useHistory integration', () => {
  beforeEach(() => {
    mockSocket.connected = false;
    mockSocket.listeners.clear();
    mockSocket.emitted = [];
    control.canUndo = false;
    control.canRedo = false;
    control.undo = () => {};
    control.redo = () => {};
    control.reconnectCount = 0;
  });

  it('updates canUndo/canRedo from history:state and triggers undo/redo emits', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => {
      root.render(<Harness />);
    });

    await act(async () => {
      mockSocket.trigger('connect');
    });

    expect(mockSocket.emitted).toContainEqual({
      event: 'board:join',
      payload: { boardId: 'board-1', userName: 'Tester', userColor: '#000000' },
    });

    await act(async () => {
      mockSocket.trigger('history:state', { undoDepth: 2, redoDepth: 1 });
    });

    expect(control.canUndo).toBe(true);
    expect(control.canRedo).toBe(true);

    await act(async () => {
      control.undo();
      control.redo();
    });

    expect(mockSocket.emitted).toContainEqual({ event: 'element:undo', payload: { boardId: 'board-1' } });
    expect(mockSocket.emitted).toContainEqual({ event: 'element:redo', payload: { boardId: 'board-1' } });

    // Second connect in the same hook session is treated as reconnect.
    await act(async () => {
      mockSocket.trigger('connect');
    });

    expect(control.reconnectCount).toBe(1);

    await act(async () => {
      root.unmount();
    });

    expect(mockSocket.emitted).toContainEqual({ event: 'board:leave', payload: { boardId: 'board-1' } });
  });
});
