'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { useUserStore } from '@/store/userStore';
import { useBoardStore } from '@/store/boardStore';
import { boardService } from '@/lib/boardService';
import { useWebSocket } from '@/hooks/useWebSocket';
import { Board } from '@/types/board';
import { Element, ElementType } from '@/types/element';
import Toolbar from '@/components/board/Toolbar';

// Dynamic import to avoid SSR issues with Fabric.js
const Canvas = dynamic(() => import('@/components/board/Canvas'), {
  ssr: false,
});

// Deterministic color from user id so the same user always gets the same cursor color
function userIdToColor(id: string): string {
  const palette = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899'];
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = id.charCodeAt(i) + ((hash << 5) - hash);
  }
  return palette[Math.abs(hash) % palette.length];
}

export default function BoardPage() {
  const params = useParams();
  const router = useRouter();
  const user = useUserStore((state) => state.user);
  const boardId = params.id as string;

  // Element state lives in the store so WebSocket callbacks can update it
  const elements = useBoardStore((state) => state.elements);
  const setElements = useBoardStore((state) => state.setElements);
  const updateElement = useBoardStore((state) => state.updateElement);
  const removeElement = useBoardStore((state) => state.removeElement);
  const applyRemoteChange = useBoardStore((state) => state.applyRemoteChange);
  const setActiveUsers = useBoardStore((state) => state.setActiveUsers);
  const addActiveUser = useBoardStore((state) => state.addActiveUser);
  const removeActiveUser = useBoardStore((state) => state.removeActiveUser);
  const updateUserCursor = useBoardStore((state) => state.updateUserCursor);
  const reset = useBoardStore((state) => state.reset);

  const [board, setBoard] = useState<Board | null>(null);
  const [selectedTool, setSelectedTool] = useState<string>('select');
  const [loading, setLoading] = useState(true);

  const userColor = useMemo(() => (user ? userIdToColor(user.id) : '#3b82f6'), [user]);

  // ─── Stable WebSocket callbacks (refs inside the hook prevent re-subscriptions) ─
  const handleElementCreated = useCallback((el: Element) => applyRemoteChange(el), [applyRemoteChange]);
  const handleElementUpdated = useCallback(
    (id: string, properties: Record<string, unknown>) => updateElement(id, properties),
    [updateElement]
  );
  const handleElementDeleted = useCallback((id: string) => removeElement(id), [removeElement]);
  const handleActiveUsers = useCallback(
    (users: Parameters<typeof setActiveUsers>[0]) => setActiveUsers(users),
    [setActiveUsers]
  );
  const handleUserJoined = useCallback(
    (u: Parameters<typeof addActiveUser>[0]) => addActiveUser(u),
    [addActiveUser]
  );
  const handleUserLeft = useCallback((userId: string) => removeActiveUser(userId), [removeActiveUser]);
  const handleCursorUpdate = useCallback(
    (userId: string, x: number, y: number) => updateUserCursor(userId, x, y),
    [updateUserCursor]
  );

  const { emitCursorMove, emitCreateElement, emitUpdateElement, emitDeleteElement } =
    useWebSocket({
      boardId,
      userName: user?.name ?? '',
      userColor,
      onElementCreated: handleElementCreated,
      onElementUpdated: handleElementUpdated,
      onElementDeleted: handleElementDeleted,
      onActiveUsers: handleActiveUsers,
      onUserJoined: handleUserJoined,
      onUserLeft: handleUserLeft,
      onCursorUpdate: handleCursorUpdate,
    });

  // ─── Load board + elements ──────────────────────────────────────────────────
  useEffect(() => {
    if (!user) {
      router.push('/login');
      return;
    }

    reset(); // clear stale state from a previous board

    const load = async () => {
      try {
        const [boardData, elementsData] = await Promise.all([
          boardService.getBoard(boardId),
          boardService.getBoardElements(boardId),
        ]);
        setBoard(boardData);
        setElements(elementsData);
      } catch (err) {
        console.error('Failed to load board:', err);
        router.push('/boards');
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [boardId, user, router, reset, setElements]);

  // ─── Canvas → WebSocket bridge ──────────────────────────────────────────────
  const handleElementCreate = useCallback(
    (element: Partial<Element>) => {
      if (!element.type || !element.properties) return;
      emitCreateElement(element.type as ElementType, element.properties as Record<string, unknown>);
    },
    [emitCreateElement]
  );

  const handleElementUpdate = useCallback(
    (id: string, updates: Partial<Element>) => {
      if (!updates.properties) return;
      emitUpdateElement(id, updates.properties as Record<string, unknown>);
    },
    [emitUpdateElement]
  );

  const handleElementDelete = useCallback(
    (id: string) => emitDeleteElement(id),
    [emitDeleteElement]
  );

  // ─── Mouse move → broadcast cursor position ─────────────────────────────────
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      emitCursorMove(e.clientX - rect.left, e.clientY - rect.top);
    },
    [emitCursorMove]
  );

  // ─── Render ──────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center">
        <p>Loading board...</p>
      </div>
    );
  }

  if (!board) {
    return (
      <div className="h-screen flex items-center justify-center">
        <p>Board not found</p>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen relative overflow-hidden">
      {/* Header */}
      <div className="absolute top-0 left-0 right-0 h-16 bg-white border-b z-10 flex items-center px-4">
        <h1 className="text-xl font-semibold">{board.title}</h1>
      </div>

      {/* Toolbar */}
      <div className="absolute top-16 left-0 right-0 z-10 flex justify-center pt-4">
        <Toolbar
          selectedTool={selectedTool}
          onToolSelect={setSelectedTool}
          onUndo={() => {}}
          onRedo={() => {}}
          onExport={() => {}}
          onShare={() => {}}
          canUndo={false}
          canRedo={false}
        />
      </div>

      {/* Canvas — wrapping div captures mouse for cursor broadcasting */}
      <div
        className="absolute top-16 left-0 right-0 bottom-0"
        onMouseMove={handleMouseMove}
      >
        <Canvas
          boardId={boardId}
          elements={elements}
          onElementCreate={handleElementCreate}
          onElementUpdate={handleElementUpdate}
          onElementDelete={handleElementDelete}
          selectedTool={selectedTool as 'select' | 'rectangle' | 'circle' | 'text' | 'sticky_note'}
        />
      </div>
    </div>
  );
}
