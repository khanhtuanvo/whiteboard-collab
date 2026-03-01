'use client';

import { useEffect, useRef, useCallback } from 'react';
import { getSocket } from '@/lib/socket';
import { Element, ElementType } from '@/types/element';
import { ActiveUser } from '@/store/boardStore';

interface UseWebSocketOptions {
  boardId: string;
  userName: string;
  userColor: string;
  onElementCreated: (element: Element) => void;
  onElementUpdated: (id: string, properties: Record<string, unknown>) => void;
  onElementDeleted: (id: string) => void;
  onActiveUsers: (users: ActiveUser[]) => void;
  onUserJoined: (user: Omit<ActiveUser, 'cursor' | 'lastSeen'>) => void;
  onUserLeft: (userId: string) => void;
  onCursorUpdate: (userId: string, x: number, y: number) => void;
}

export function useWebSocket({
  boardId,
  userName,
  userColor,
  onElementCreated,
  onElementUpdated,
  onElementDeleted,
  onActiveUsers,
  onUserJoined,
  onUserLeft,
  onCursorUpdate,
}: UseWebSocketOptions) {
  // Keep callbacks in refs so the effect never needs to re-run when they change
  const onElementCreatedRef = useRef(onElementCreated);
  const onElementUpdatedRef = useRef(onElementUpdated);
  const onElementDeletedRef = useRef(onElementDeleted);
  const onActiveUsersRef = useRef(onActiveUsers);
  const onUserJoinedRef = useRef(onUserJoined);
  const onUserLeftRef = useRef(onUserLeft);
  const onCursorUpdateRef = useRef(onCursorUpdate);

  useEffect(() => { onElementCreatedRef.current = onElementCreated; });
  useEffect(() => { onElementUpdatedRef.current = onElementUpdated; });
  useEffect(() => { onElementDeletedRef.current = onElementDeleted; });
  useEffect(() => { onActiveUsersRef.current = onActiveUsers; });
  useEffect(() => { onUserJoinedRef.current = onUserJoined; });
  useEffect(() => { onUserLeftRef.current = onUserLeft; });
  useEffect(() => { onCursorUpdateRef.current = onCursorUpdate; });

  useEffect(() => {
    // Don't connect if user isn't authenticated yet
    if (!userName) return;

    const socket = getSocket();

    // Join the board room
    socket.emit('board:join', { boardId, userName, userColor });

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
      onElementCreatedRef.current(element);
    };

    const handleElementUpdated = (data: { id: string; properties: Record<string, unknown> }) => {
      onElementUpdatedRef.current(data.id, data.properties);
    };

    const handleElementDeleted = (data: { id: string }) => {
      onElementDeletedRef.current(data.id);
    };

    socket.on('board:active_users', handleActiveUsers);
    socket.on('user:joined', handleUserJoined);
    socket.on('user:left', handleUserLeft);
    socket.on('cursor:update', handleCursorUpdate);
    socket.on('element:created', handleElementCreated);
    socket.on('element:updated', handleElementUpdated);
    socket.on('element:deleted', handleElementDeleted);

    return () => {
      socket.emit('board:leave', { boardId });
      socket.off('board:active_users', handleActiveUsers);
      socket.off('user:joined', handleUserJoined);
      socket.off('user:left', handleUserLeft);
      socket.off('cursor:update', handleCursorUpdate);
      socket.off('element:created', handleElementCreated);
      socket.off('element:updated', handleElementUpdated);
      socket.off('element:deleted', handleElementDeleted);
    };
  }, [boardId, userName, userColor]);

  const emitCursorMove = useCallback((x: number, y: number) => {
    getSocket().emit('cursor:move', { boardId, x, y });
  }, [boardId]);

  const emitCreateElement = useCallback((type: ElementType, properties: Record<string, unknown>) => {
    getSocket().emit('element:create', { boardId, type, properties });
  }, [boardId]);

  const emitUpdateElement = useCallback((elementId: string, properties: Record<string, unknown>) => {
    getSocket().emit('element:update', { boardId, elementId, properties });
  }, [boardId]);

  const emitDeleteElement = useCallback((elementId: string) => {
    getSocket().emit('element:delete', { boardId, elementId });
  }, [boardId]);

  return { emitCursorMove, emitCreateElement, emitUpdateElement, emitDeleteElement };
}
