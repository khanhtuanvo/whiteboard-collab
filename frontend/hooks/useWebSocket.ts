'use client';

import { useEffect, useRef, useCallback } from 'react';
import { getSocket } from '@/lib/socket';
import { Element, ElementType, deserializeElement } from '@/types/element';
import { ActiveUser } from '@/store/boardStore';

interface UseWebSocketOptions {
  boardId: string;
  userName: string;
  userColor: string;
  onElementCreated: (element: Element) => void;
  onElementUpdated: (id: string, properties: Record<string, unknown>, zIndex?: number) => void;
  onElementDeleted: (id: string) => void;
  onSnapshot: (elements: Element[]) => void;
  onActiveUsers: (users: ActiveUser[]) => void;
  onUserJoined: (user: Omit<ActiveUser, 'cursor' | 'lastSeen'>) => void;
  onUserLeft: (userId: string) => void;
  onCursorUpdate: (userId: string, x: number, y: number) => void;
  onBoardCleared?: () => void;
  /** C3: Called when server reports updated undo/redo stack depths */
  onHistoryState?: (undoDepth: number, redoDepth: number) => void;
  /** Called on every socket reconnect (not the initial connect). Use to re-sync board state. */
  onReconnect?: () => void;
}

export function useWebSocket({
  boardId,
  userName,
  userColor,
  onElementCreated,
  onElementUpdated,
  onElementDeleted,
  onSnapshot,
  onActiveUsers,
  onUserJoined,
  onUserLeft,
  onCursorUpdate,
  onBoardCleared,
  onHistoryState,
  onReconnect,
}: UseWebSocketOptions) {
  // Keep callbacks in refs so the effect never needs to re-run when they change
  const onElementCreatedRef = useRef(onElementCreated);
  const onElementUpdatedRef = useRef(onElementUpdated);
  const onElementDeletedRef = useRef(onElementDeleted);
  const onSnapshotRef = useRef(onSnapshot);
  const onActiveUsersRef = useRef(onActiveUsers);
  const onUserJoinedRef = useRef(onUserJoined);
  const onUserLeftRef = useRef(onUserLeft);
  const onCursorUpdateRef = useRef(onCursorUpdate);
  const onBoardClearedRef = useRef(onBoardCleared);
  const onHistoryStateRef = useRef(onHistoryState);
  const onReconnectRef = useRef(onReconnect);

  useEffect(() => { onElementCreatedRef.current = onElementCreated; });
  useEffect(() => { onElementUpdatedRef.current = onElementUpdated; });
  useEffect(() => { onElementDeletedRef.current = onElementDeleted; });
  useEffect(() => { onSnapshotRef.current = onSnapshot; });
  useEffect(() => { onActiveUsersRef.current = onActiveUsers; });
  useEffect(() => { onUserJoinedRef.current = onUserJoined; });
  useEffect(() => { onUserLeftRef.current = onUserLeft; });
  useEffect(() => { onCursorUpdateRef.current = onCursorUpdate; });
  useEffect(() => { onBoardClearedRef.current = onBoardCleared; });
  useEffect(() => { onHistoryStateRef.current = onHistoryState; });
  useEffect(() => { onReconnectRef.current = onReconnect; });

  // Tracks whether the socket has successfully joined at least once for this
  // board session. Reset to false each time the effect re-runs (new boardId /
  // userName) so the very first join is never mistaken for a reconnect.
  const hasJoinedRef = useRef(false);

  useEffect(() => {
    // Don't connect if user isn't authenticated yet
    if (!userName) return;

    const socket = getSocket();

    // Reset join tracking for this session (new boardId / userName)
    hasJoinedRef.current = false;

    // Emits board:join and — if this is a reconnect after a prior disconnect —
    // notifies the caller so it can re-sync board state.
    // Socket.IO fires 'connect' on the very first connection AND on every
    // subsequent reconnect, so this single handler covers both cases.
    const handleConnect = () => {
      socket.emit('board:join', { boardId, userName, userColor });
      if (hasJoinedRef.current) {
        // Second+ connect event for this session = reconnect
        onReconnectRef.current?.();
      }
      hasJoinedRef.current = true;
    };

    // If the socket is already connected when this effect runs (common on
    // navigation between boards), join immediately without waiting for 'connect'.
    if (socket.connected) {
      handleConnect();
    }
    socket.on('connect', handleConnect);

    // Receive the full list of current active users on join
    const handleActiveUsers = (users: ActiveUser[]) => {
      onActiveUsersRef.current(users);
    };

    const handleUserJoined = (data: { userId: string; userName: string; userColor: string }) => {
      onUserJoinedRef.current({ socketId: '', userId: data.userId, userName: data.userName, userColor: data.userColor });
    };

    const handleUserLeft = (data: { userId: string }) => {
      onUserLeftRef.current(data.userId);
    };

    const handleCursorUpdate = (data: { userId: string; x: number; y: number }) => {
      onCursorUpdateRef.current(data.userId, data.x, data.y);
    };

    const handleElementCreated = (element: Element) => {
      onElementCreatedRef.current(deserializeElement(element));
    };

    const handleElementUpdated = (data: { id: string; properties: Record<string, unknown>; zIndex?: number }) => {
      onElementUpdatedRef.current(data.id, data.properties, data.zIndex);
    };

    const handleElementDeleted = (data: { id: string }) => {
      onElementDeletedRef.current(data.id);
    };

    const handleSnapshot = (elements: Element[]) => {
      onSnapshotRef.current(elements.map(deserializeElement));
    };

    const handleBoardCleared = () => {
      onBoardClearedRef.current?.();
    };

    const handleHistoryState = (data: { undoDepth: number; redoDepth: number }) => {
      onHistoryStateRef.current?.(data.undoDepth, data.redoDepth);
    };

    // room:users carries the full active-user list; replaces the piecemeal
    // board:active_users / user:joined / user:left trio for presence sync.
    const handleRoomUsers = (users: ActiveUser[]) => {
      onActiveUsersRef.current(users);
    };

    socket.on('board:active_users', handleActiveUsers);
    socket.on('user:joined', handleUserJoined);
    socket.on('user:left', handleUserLeft);
    socket.on('room:users', handleRoomUsers);
    socket.on('cursor:update', handleCursorUpdate);
    socket.on('element:created', handleElementCreated);
    socket.on('element:updated', handleElementUpdated);
    socket.on('element:deleted', handleElementDeleted);
    socket.on('element:snapshot', handleSnapshot);
    socket.on('board:cleared', handleBoardCleared);
    socket.on('history:state', handleHistoryState);

    return () => {
      socket.emit('board:leave', { boardId });
      socket.off('connect', handleConnect);
      socket.off('board:active_users', handleActiveUsers);
      socket.off('user:joined', handleUserJoined);
      socket.off('user:left', handleUserLeft);
      socket.off('room:users', handleRoomUsers);
      socket.off('cursor:update', handleCursorUpdate);
      socket.off('element:created', handleElementCreated);
      socket.off('element:updated', handleElementUpdated);
      socket.off('element:deleted', handleElementDeleted);
      socket.off('element:snapshot', handleSnapshot);
      socket.off('board:cleared', handleBoardCleared);
      socket.off('history:state', handleHistoryState);
    };
  }, [boardId, userName, userColor]);

  const lastCursorEmitRef = useRef(0);
  const CURSOR_EMIT_INTERVAL = 35; // Throttle to ~28 cursor moves/sec (backend limit is 30/sec)

  const emitCursorMove = useCallback((x: number, y: number) => {
    const now = Date.now();
    if (now - lastCursorEmitRef.current >= CURSOR_EMIT_INTERVAL) {
      lastCursorEmitRef.current = now;
      getSocket().emit('cursor:move', { boardId, x, y });
    }
  }, [boardId]);

  const emitCreateElement = useCallback((type: ElementType, properties: Record<string, unknown>, id?: string) => {
    getSocket().emit('element:create', { boardId, type, properties, ...(id ? { id } : {}) });
  }, [boardId]);

  const emitUpdateElement = useCallback((elementId: string, properties: Record<string, unknown>) => {
    getSocket().emit('element:update', { boardId, elementId, properties });
  }, [boardId]);

  /** Live drag-position broadcast — backend skips snapshot for these */
  const emitLiveUpdateElement = useCallback((elementId: string, properties: Record<string, unknown>) => {
    getSocket().emit('element:update', { boardId, elementId, properties, live: true });
  }, [boardId]);

  const emitDeleteElement = useCallback((elementId: string) => {
    getSocket().emit('element:delete', { boardId, elementId });
  }, [boardId]);

  const emitUndo = useCallback(() => {
    getSocket().emit('element:undo', { boardId });
  }, [boardId]);

  const emitRedo = useCallback(() => {
    getSocket().emit('element:redo', { boardId });
  }, [boardId]);

  const emitClearBoard = useCallback(() => {
    getSocket().emit('board:clear', { boardId });
  }, [boardId]);

  return { emitCursorMove, emitCreateElement, emitUpdateElement, emitLiveUpdateElement, emitDeleteElement, emitUndo, emitRedo, emitClearBoard };
}
