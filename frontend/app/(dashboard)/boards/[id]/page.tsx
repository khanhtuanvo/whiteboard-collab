'use client';

import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { toast } from 'sonner';
import { useUserStore } from '@/store/userStore';
import { useBoardStore } from '@/store/boardStore';
import { boardService } from '@/lib/boardService';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useHistory } from '@/hooks/useHistory';
import { Board } from '@/types/board';
import { Element, ElementType } from '@/types/element';
import Toolbar from '@/components/board/Toolbar';
import Cursor from '@/components/board/Cursor';
import ColorPicker from '@/components/board/ColorPicker';
import ConnectionBanner from '@/components/board/ConnectionBanner';
import ClusterSuggestions from '@/components/ai/ClusterSuggestions';
import type { CanvasHandle, CanvasProps } from '@/components/board/Canvas';

// Dynamic import to avoid SSR issues with Fabric.js
const Canvas = dynamic(() => import('@/components/board/Canvas'), {
  ssr: false,
}) as React.ComponentType<CanvasProps & React.RefAttributes<CanvasHandle>>;

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
  const activeUsers = useBoardStore((state) => state.activeUsers);
  const setElements = useBoardStore((state) => state.setElements);
  const updateElement = useBoardStore((state) => state.updateElement);
  const removeElement = useBoardStore((state) => state.removeElement);
  const clearElements = useBoardStore((state) => state.clearElements);
  const applyRemoteChange = useBoardStore((state) => state.applyRemoteChange);
  const setActiveUsers = useBoardStore((state) => state.setActiveUsers);
  const addActiveUser = useBoardStore((state) => state.addActiveUser);
  const removeActiveUser = useBoardStore((state) => state.removeActiveUser);
  const updateUserCursor = useBoardStore((state) => state.updateUserCursor);
  const reset = useBoardStore((state) => state.reset);

  // Race-condition guard: buffer incoming socket events until the initial HTTP
  // fetch has completed. Events that arrive before initialization are replayed
  // afterward; events whose element ID already exists are skipped (dedup).
  const isInitializedRef = useRef(false);
  const pendingCreatesRef = useRef<Element[]>([]);

  const [board, setBoard] = useState<Board | null>(null);
  const [selectedTool, setSelectedTool] = useState<string>('select');
  const [loading, setLoading] = useState(true);

  // Phase 1.5: selected element + zoom tracking
  const [selectedElementId, setSelectedElementId] = useState<string | null>(null);
  const [zoomLevel, setZoomLevel] = useState(1);

  // Share dialog state
  const [shareOpen, setShareOpen] = useState(false);
  const [shareEmail, setShareEmail] = useState('');
  const [shareRole, setShareRole] = useState<'VIEWER' | 'EDITOR' | 'ADMIN'>('EDITOR');
  const [sharing, setSharing] = useState(false);

  const canvasRef = useRef<CanvasHandle>(null);

  const userColor = useMemo(() => (user ? userIdToColor(user.id) : '#3b82f6'), [user]);

  // Derive the currently selected element object from the store
  const selectedElement = useMemo(
    () => (selectedElementId ? elements.find(el => el.id === selectedElementId) ?? null : null),
    [selectedElementId, elements]
  );

  // ─── Stable WebSocket callbacks ─────────────────────────────────────────────
  const handleElementCreated = useCallback((el: Element) => {
    if (!isInitializedRef.current) {
      // Buffer until the initial HTTP fetch completes
      pendingCreatesRef.current.push(el);
      return;
    }
    applyRemoteChange(el);
  }, [applyRemoteChange]);
  const handleElementUpdated = useCallback(
    (id: string, properties: Record<string, unknown>) => updateElement(id, properties),
    [updateElement]
  );
  const handleElementDeleted = useCallback((id: string) => removeElement(id), [removeElement]);
  const handleSnapshot = useCallback((els: Element[]) => setElements(els), [setElements]);
  const handleBoardCleared = useCallback(() => clearElements(), [clearElements]);
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

  const { emitCursorMove, emitCreateElement, emitUpdateElement, emitDeleteElement, emitUndo, emitRedo, emitClearBoard } =
    useWebSocket({
      boardId,
      userName: user?.name ?? '',
      userColor,
      onElementCreated: handleElementCreated,
      onElementUpdated: handleElementUpdated,
      onElementDeleted: handleElementDeleted,
      onSnapshot: handleSnapshot,
      onActiveUsers: handleActiveUsers,
      onUserJoined: handleUserJoined,
      onUserLeft: handleUserLeft,
      onCursorUpdate: handleCursorUpdate,
      onBoardCleared: handleBoardCleared,
    });

  const { undo, redo, recordAction, canUndo, canRedo } = useHistory({
    boardId,
    emitUndo,
    emitRedo,
  });

  // ─── Load board + elements ──────────────────────────────────────────────────
  useEffect(() => {
    if (!user) {
      router.push('/login');
      return;
    }

    isInitializedRef.current = false;
    pendingCreatesRef.current = [];
    reset();

    const load = async () => {
      try {
        const [boardData, elementsData] = await Promise.all([
          boardService.getBoard(boardId),
          boardService.getBoardElements(boardId),
        ]);
        setBoard(boardData);
        setElements(elementsData);

        // Mark as initialized and replay any events that arrived during the fetch,
        // skipping duplicates whose ID is already present in elementsData.
        isInitializedRef.current = true;
        const fetchedIds = new Set(elementsData.map((el: Element) => el.id));
        for (const el of pendingCreatesRef.current) {
          if (!fetchedIds.has(el.id)) applyRemoteChange(el);
        }
        pendingCreatesRef.current = [];
      } catch (err) {
        console.error('Failed to load board:', err);
        router.push('/boards');
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [boardId, user, router, reset, setElements]);

  // ─── Keyboard shortcuts (Ctrl+Z / Ctrl+Y) ───────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [undo, redo]);

  // ─── Canvas → WebSocket bridge ──────────────────────────────────────────────
  const handleElementCreate = useCallback(
    (element: Partial<Element>) => {
      if (!element.type || !element.properties) return;
      emitCreateElement(element.type as ElementType, element.properties as Record<string, unknown>);
      recordAction();
    },
    [emitCreateElement, recordAction]
  );

  const handleElementUpdate = useCallback(
    (id: string, updates: Partial<Element>) => {
      // Build a flat payload: properties fields + optional top-level zIndex
      const payload: Record<string, unknown> = { ...(updates.properties ?? {}) };
      if (updates.zIndex !== undefined) payload.zIndex = updates.zIndex;
      if (Object.keys(payload).length === 0) return;
      emitUpdateElement(id, payload);
      recordAction();
    },
    [emitUpdateElement, recordAction]
  );

  const handleElementDelete = useCallback(
    (id: string) => {
      // Optimistic removal: remove immediately so the canvas updates without
      // waiting for the server round-trip, making delete feel instant.
      removeElement(id);
      emitDeleteElement(id);
      setSelectedElementId(prev => (prev === id ? null : prev));
      recordAction();
    },
    [removeElement, emitDeleteElement, recordAction]
  );

  const handleClearAll = useCallback(() => {
    emitClearBoard();
  }, [emitClearBoard]);

  // ─── Color change from ColorPicker ──────────────────────────────────────────
  const handleColorChange = useCallback(
    (changes: { fill?: string; stroke?: string }) => {
      if (!selectedElementId || !selectedElement) return;
      handleElementUpdate(selectedElementId, {
        properties: { ...selectedElement.properties, ...changes },
      });
    },
    [selectedElementId, selectedElement, handleElementUpdate]
  );

  // ─── Mouse move → broadcast cursor position ─────────────────────────────────
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      emitCursorMove(e.clientX - rect.left, e.clientY - rect.top);
    },
    [emitCursorMove]
  );

  // ─── Export ──────────────────────────────────────────────────────────────────
  const handleExport = useCallback(() => {
    canvasRef.current?.exportImage();
  }, []);

  const handleExportSVG = useCallback(() => {
    canvasRef.current?.exportSVG();
  }, []);

  // ─── Share ───────────────────────────────────────────────────────────────────
  const handleShare = useCallback(async () => {
    if (!shareEmail.trim()) return;
    setSharing(true);
    try {
      await boardService.addCollaborator(boardId, shareEmail.trim(), shareRole);
      toast.success(`Invited ${shareEmail.trim()} as ${shareRole.toLowerCase()}`);
      setShareEmail('');
      setShareOpen(false);
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? 'Failed to add collaborator');
    } finally {
      setSharing(false);
    }
  }, [boardId, shareEmail, shareRole]);

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

  const remoteCursors = activeUsers.filter(u => u.userId !== user?.id);

  return (
    <div className="h-screen w-screen relative overflow-hidden">
      {/* Header */}
      <div className="absolute top-0 left-0 right-0 h-16 bg-white border-b z-10 flex items-center px-4 gap-4">
        <h1 className="text-xl font-semibold flex-1 truncate">{board.title}</h1>

        {/* Active users avatar stack */}
        <div className="flex items-center">
          {activeUsers.slice(0, 5).map((u, i) => (
            <div
              key={u.userId}
              title={u.userName}
              className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold border-2 border-white shadow-sm select-none cursor-default"
              style={{
                backgroundColor: u.userColor,
                marginLeft: i === 0 ? 0 : '-0.5rem',
                zIndex: 5 - i,
                position: 'relative',
              }}
            >
              {u.userName.charAt(0).toUpperCase()}
            </div>
          ))}
          {activeUsers.length > 5 && (
            <span
              className="w-8 h-8 rounded-full flex items-center justify-center bg-gray-200 text-gray-600 text-xs font-bold border-2 border-white shadow-sm -ml-2 select-none"
              title={activeUsers.slice(5).map(u => u.userName).join(', ')}
              style={{ position: 'relative', zIndex: 0 }}
            >
              +{activeUsers.length - 5}
            </span>
          )}
        </div>
      </div>

      {/* Toolbar — centered at the top */}
      <div className="absolute top-16 left-0 right-0 z-10 flex justify-center pt-4 gap-2">
        <Toolbar
          selectedTool={selectedTool}
          onToolSelect={setSelectedTool}
          onUndo={undo}
          onRedo={redo}
          onExport={handleExport}
          onExportSVG={handleExportSVG}
          onShare={() => setShareOpen(true)}
          canUndo={canUndo}
          canRedo={canRedo}
          selectedElement={selectedElement}
          onElementDelete={handleElementDelete}
          onElementUpdate={handleElementUpdate}
          zoomLevel={zoomLevel}
          elements={elements}
          onClearAll={handleClearAll}
          onDeleteSelected={() => canvasRef.current?.deleteSelected()}
        />
        <div className="bg-white shadow-lg rounded-lg p-2 flex items-center">
          <ClusterSuggestions
            boardId={boardId}
            elements={elements}
            onElementUpdate={handleElementUpdate}
          />
        </div>
      </div>

      {/* ColorPicker — floats in the top-right when an element is selected */}
      {selectedElement && (
        <div className="absolute top-32 right-4 z-10">
          <ColorPicker
            fill={selectedElement.properties.fill ?? selectedElement.properties.color}
            stroke={selectedElement.properties.stroke}
            onChange={handleColorChange}
          />
        </div>
      )}

      {/* Reconnection banner */}
      <ConnectionBanner boardId={boardId} />

      {/* Canvas — wrapping div captures mouse for cursor broadcasting */}
      <div
        className="absolute top-16 left-0 right-0 bottom-0"
        onMouseMove={handleMouseMove}
      >
        <Canvas
          ref={canvasRef}
          boardId={boardId}
          elements={elements}
          onElementCreate={handleElementCreate}
          onElementUpdate={handleElementUpdate}
          onElementDelete={handleElementDelete}
          selectedTool={selectedTool as 'select' | 'rectangle' | 'circle' | 'text' | 'sticky_note' | 'pen' | 'line' | 'arrow'}
          onSelectionChange={setSelectedElementId}
          onZoomChange={setZoomLevel}
        />

        {/* Remote cursors */}
        {remoteCursors.map(u =>
          u.cursor ? (
            <Cursor
              key={u.userId}
              x={u.cursor.x}
              y={u.cursor.y}
              color={u.userColor}
              name={u.userName}
            />
          ) : null
        )}
      </div>

      {/* Share dialog */}
      {shareOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-lg shadow-xl p-6 w-96">
            <h2 className="text-lg font-semibold mb-4">Share Board</h2>

            <label className="block text-sm font-medium mb-1">Email address</label>
            <input
              type="email"
              className="w-full border rounded px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="colleague@example.com"
              value={shareEmail}
              onChange={e => setShareEmail(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleShare()}
            />

            <label className="block text-sm font-medium mb-1">Role</label>
            <select
              className="w-full border rounded px-3 py-2 text-sm mb-4"
              value={shareRole}
              onChange={e => setShareRole(e.target.value as typeof shareRole)}
            >
              <option value="VIEWER">Viewer</option>
              <option value="EDITOR">Editor</option>
              <option value="ADMIN">Admin</option>
            </select>

            <div className="flex justify-end gap-2">
              <button
                className="px-4 py-2 text-sm rounded border hover:bg-gray-50"
                onClick={() => { setShareOpen(false); setShareEmail(''); }}
              >
                Cancel
              </button>
              <button
                className="px-4 py-2 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                onClick={handleShare}
                disabled={sharing || !shareEmail.trim()}
              >
                {sharing ? 'Inviting…' : 'Invite'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
