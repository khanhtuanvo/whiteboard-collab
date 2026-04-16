'use client';

import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import axios from 'axios';
import { toast } from 'sonner';
import { useUserStore } from '@/store/userStore';
import { useBoardStore } from '@/store/boardStore';
import { boardService } from '@/lib/boardService';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useHistory } from '@/hooks/useHistory';
import { Board } from '@/types/board';
import { Element, ElementType, deserializeElement } from '@/types/element';
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
  const _hasHydrated = useUserStore((state) => state._hasHydrated);
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

  // ─── Init gate + ordered event buffer ───────────────────────────────────────
  // Problem: WebSocket events (create/update/delete/clear/snapshot) can arrive
  // BEFORE the initial REST fetch completes.  Naively applying them causes
  // duplicates, stale overwrites, or missed deletes.
  //
  // Solution: buffer ALL canvas-mutating events in arrival order while
  // isInitializedRef === false.  After the fetch lands, replay the queue in
  // order with dedup on element IDs already present in the REST response.
  //
  // Reconnect: loadBoard() is re-invoked on every socket reconnect.  A numeric
  // abort key ensures only the most-recent in-flight load applies its result.
  type BufferedEvent =
    | { kind: 'created';  payload: Element }
    | { kind: 'updated';  id: string; properties: Record<string, unknown>; zIndex?: number }
    | { kind: 'deleted';  id: string }
    | { kind: 'snapshot'; elements: Element[] }
    | { kind: 'cleared' };

  const isInitializedRef = useRef(false);
  const eventQueueRef    = useRef<BufferedEvent[]>([]);
  const loadAbortKeyRef  = useRef(0);

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

  const [userColor, setUserColor] = useState(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('cursorColor');
      if (stored) return stored;
    }
    return user ? userIdToColor(user.id) : '#3b82f6';
  });

  useEffect(() => {
    const stored = localStorage.getItem('cursorColor');
    setUserColor(stored ?? (user ? userIdToColor(user.id) : '#3b82f6'));
  }, [user]);

  // VIEWER role: read-only canvas, hidden edit controls
  const isReadOnly = board?.userRole === 'VIEWER';

  // Derive the currently selected element object from the store
  const selectedElement = useMemo(
    () => (selectedElementId ? elements.find(el => el.id === selectedElementId) ?? null : null),
    [selectedElementId, elements]
  );

  // ─── Canvas-state callbacks: gate on isInitializedRef ───────────────────────
  // Any of these five events arriving before the REST fetch lands are queued in
  // eventQueueRef (in arrival order) and replayed once initialization completes.
  const handleElementCreated = useCallback((el: Element) => {
    if (!isInitializedRef.current) {
      eventQueueRef.current.push({ kind: 'created', payload: el });
      return;
    }
    applyRemoteChange(el);
  }, [applyRemoteChange]);

  const handleElementUpdated = useCallback((id: string, properties: Record<string, unknown>, zIndex?: number) => {
    if (!isInitializedRef.current) {
      eventQueueRef.current.push({ kind: 'updated', id, properties, zIndex });
      return;
    }
    updateElement(id, properties as Element['properties'], zIndex);
  }, [updateElement]);

  const handleElementDeleted = useCallback((id: string) => {
    if (!isInitializedRef.current) {
      eventQueueRef.current.push({ kind: 'deleted', id });
      return;
    }
    removeElement(id);
  }, [removeElement]);

  const handleSnapshot = useCallback((els: Element[]) => {
    if (!isInitializedRef.current) {
      eventQueueRef.current.push({ kind: 'snapshot', elements: els });
      return;
    }
    setElements(els);
  }, [setElements]);

  const handleBoardCleared = useCallback(() => {
    if (!isInitializedRef.current) {
      eventQueueRef.current.push({ kind: 'cleared' });
      return;
    }
    clearElements();
  }, [clearElements]);

  // Presence callbacks — not canvas-state, never need gating
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

  // ─── loadBoard ───────────────────────────────────────────────────────────────
  // Extracted so it can be called both on mount and on every socket reconnect.
  // isReconnect=true keeps the current elements visible during the background
  // resync instead of showing the full-screen loader.
  const loadBoard = useCallback(async (isReconnect = false) => {
    // Abort key: if a newer loadBoard call starts before this one finishes,
    // the stale response is discarded so it cannot overwrite fresher data.
    const key = ++loadAbortKeyRef.current;

    isInitializedRef.current = false;
    eventQueueRef.current = [];

    if (!isReconnect) {
      setLoading(true);
      reset();
    }

    try {
      const [boardData, elementsData] = await Promise.all([
        boardService.getBoard(boardId),
        boardService.getBoardElements(boardId),
      ]);

      if (key !== loadAbortKeyRef.current) return; // Stale — a newer load is in flight

      setBoard(boardData);
      const fetchedElements = elementsData.map(deserializeElement);
      setElements(fetchedElements);

      // Build a working ID set so the replay loop can track creates/deletes
      const fetchedIds = new Set(fetchedElements.map((el: Element) => el.id));

      // Open the gate before replaying so any events that arrive mid-replay go
      // directly to the store instead of being re-queued.
      isInitializedRef.current = true;

      for (const event of eventQueueRef.current) {
        switch (event.kind) {
          case 'created':
            if (!fetchedIds.has(event.payload.id)) {
              applyRemoteChange(event.payload);
              fetchedIds.add(event.payload.id);
            }
            break;
          case 'updated':
            updateElement(event.id, event.properties as Element['properties'], event.zIndex);
            break;
          case 'deleted':
            removeElement(event.id);
            fetchedIds.delete(event.id);
            break;
          case 'snapshot':
            setElements(event.elements);
            break;
          case 'cleared':
            clearElements();
            break;
        }
      }
      eventQueueRef.current = [];
    } catch (err) {
      if (key !== loadAbortKeyRef.current) return;
      console.error('Failed to load board:', err);
      if (!isReconnect) router.push('/boards');
    } finally {
      if (key === loadAbortKeyRef.current) setLoading(false);
    }
  }, [boardId, reset, setElements, applyRemoteChange, updateElement, removeElement, clearElements, router]);

  // Called by useWebSocket whenever the socket reconnects (after a disconnect).
  // Re-runs the full fetch+replay cycle without showing the loading screen.
  const handleReconnect = useCallback(() => {
    loadBoard(true);
  }, [loadBoard]);

  // C3: Stable indirection ref breaks the circular dep between useWebSocket and useHistory
  const historyStateSetterRef = useRef<(undoDepth: number, redoDepth: number) => void>(() => {});
  const stableHistoryStateCallback = useCallback((u: number, r: number) => {
    historyStateSetterRef.current(u, r);
  }, []);

  const { emitCursorMove, emitCreateElement, emitUpdateElement, emitBulkUpdateElements, emitLiveUpdateElement, emitDeleteElement, emitUndo, emitRedo, emitClearBoard } =
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
      onHistoryState: stableHistoryStateCallback,
      onReconnect: handleReconnect,
    });

  const { undo, redo, setHistoryState, canUndo, canRedo } = useHistory({
    boardId,
    emitUndo,
    emitRedo,
    onBeforeUndoRedo: useCallback(() => {
      setSelectedElementId(null);
      canvasRef.current?.clearSelection();
    }, []),
  });
  // Wire the indirection ref to the actual setter from useHistory
  historyStateSetterRef.current = setHistoryState;

  // ─── Load board + elements ──────────────────────────────────────────────────
  useEffect(() => {
    if (!_hasHydrated) return;
    if (!user) {
      router.push('/login');
      return;
    }
    loadBoard();
  }, [boardId, user, _hasHydrated, loadBoard, router]);

  // ─── Keyboard shortcuts (Ctrl+Z / Ctrl+Y) ───────────────────────────────────
  useEffect(() => {
    if (isReadOnly) return;
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
  }, [undo, redo, isReadOnly]);

  // ─── Canvas → WebSocket bridge ──────────────────────────────────────────────
  const handleElementCreate = useCallback(
    (element: Partial<Element>) => {
      if (isReadOnly || !element.type || !element.properties) return;
      emitCreateElement(element.type as ElementType, element.properties as Record<string, unknown>, element.id);
    },
    [emitCreateElement, isReadOnly]
  );

  const handleElementUpdate = useCallback(
    (id: string, updates: Partial<Element>) => {
      if (isReadOnly) return;
      // Build a flat payload: properties fields + optional top-level zIndex
      const payload: Record<string, unknown> = { ...(updates.properties ?? {}) };
      if (updates.zIndex !== undefined) payload.zIndex = updates.zIndex;
      if (Object.keys(payload).length === 0) return;
      emitUpdateElement(id, payload);
    },
    [emitUpdateElement, isReadOnly]
  );

  // Live drag updates: broadcast position for collaboration but do NOT save a snapshot.
  // History snapshot is committed via onGestureEnd (fired by Canvas on pointerup).
  const handleElementDragUpdate = useCallback(
    (id: string, updates: Partial<Element>) => {
      if (isReadOnly) return;
      const payload: Record<string, unknown> = { ...(updates.properties ?? {}) };
      if (Object.keys(payload).length === 0) return;
      emitLiveUpdateElement(id, payload);
    },
    [emitLiveUpdateElement, isReadOnly]
  );

  const handleElementDelete = useCallback(
    (id: string) => {
      if (isReadOnly) return;
      // Optimistic removal: remove immediately so the canvas updates without
      // waiting for the server round-trip, making delete feel instant.
      removeElement(id);
      emitDeleteElement(id);
      setSelectedElementId(prev => (prev === id ? null : prev));
    },
    [removeElement, emitDeleteElement, isReadOnly]
  );

  const handleClearAll = useCallback(() => {
    if (isReadOnly) return;
    emitClearBoard();
  }, [emitClearBoard, isReadOnly]);

  const handleApplyClusterSuggestions = useCallback(
    async (suggestions: { id: string; suggestedX: number; suggestedY: number }[]) => {
      const previousElements = elements;
      const suggestionMap = new Map(
        suggestions.map((suggestion) => [suggestion.id, suggestion])
      );

      // Optimistic UI update so the user immediately sees grouped notes.
      setElements(
        elements.map((element) => {
          const suggestion = suggestionMap.get(element.id);
          if (!suggestion) return element;

          return {
            ...element,
            properties: {
              ...element.properties,
              x: suggestion.suggestedX,
              y: suggestion.suggestedY,
            },
          };
        })
      );

      const updates = suggestions.map((suggestion) => {
        const element = elements.find((item) => item.id === suggestion.id);
        if (!element) {
          throw new Error('Element not found');
        }

        return {
          elementId: suggestion.id,
          properties: {
            x: suggestion.suggestedX,
            y: suggestion.suggestedY,
          },
        };
      });

      try {
        await emitBulkUpdateElements(updates);
      } catch (error) {
        // Revert optimistic UI on persistence failure.
        setElements(previousElements);
        throw error;
      }
    },
    [elements, emitBulkUpdateElements, setElements]
  );

  // ─── Color change from ColorPicker ──────────────────────────────────────────
  const handleColorChange = useCallback(
    (changes: { fill?: string; stroke?: string }) => {
      if (isReadOnly || !selectedElementId || !selectedElement) return;
      // Lines and arrows are open paths — their visual color is the stroke, not fill.
      // Remap a fill change to stroke so the Fill section in ColorPicker controls the line color.
      let effectiveChanges = changes;
      if (
        (selectedElement.type === ElementType.LINE || selectedElement.type === ElementType.ARROW) &&
        changes.fill !== undefined
      ) {
        const { fill, ...rest } = changes;
        effectiveChanges = { ...rest, stroke: fill };
      }
      handleElementUpdate(selectedElementId, {
        properties: { ...selectedElement.properties, ...effectiveChanges },
      });
    },
    [selectedElementId, selectedElement, handleElementUpdate, isReadOnly]
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
    } catch (err: unknown) {
      toast.error(axios.isAxiosError(err) ? (err.response?.data?.error ?? 'Failed to add collaborator') : 'Failed to add collaborator');
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

        {/* Read-only badge for viewers */}
        {isReadOnly && (
          <span className="text-xs font-medium bg-amber-100 text-amber-700 px-2.5 py-1 rounded-full border border-amber-200">
            View only
          </span>
        )}

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
          readOnly={isReadOnly}
        />
        {!isReadOnly && (
          <div className="bg-white shadow-lg rounded-lg p-2 flex items-center">
            <ClusterSuggestions
              boardId={boardId}
              elements={elements}
              onApplySuggestions={handleApplyClusterSuggestions}
            />
          </div>
        )}
      </div>

      {/* ColorPicker — floats in the top-right when an element is selected (editors only) */}
      {!isReadOnly && selectedElement && (
        <div className="absolute top-32 right-4 z-10">
          <ColorPicker
            fill={
              (selectedElement.type === ElementType.LINE || selectedElement.type === ElementType.ARROW)
                ? selectedElement.properties.stroke
                : (selectedElement.properties.fill ?? selectedElement.properties.color)
            }
            stroke={selectedElement.properties.stroke}
            onChange={handleColorChange}
          />
        </div>
      )}

      {/* Reconnection banner */}
      <ConnectionBanner />

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
          onElementDragUpdate={handleElementDragUpdate}
          selectedTool={isReadOnly ? 'select' : selectedTool as 'select' | 'rectangle' | 'circle' | 'text' | 'sticky_note' | 'pen' | 'line' | 'arrow'}
          onSelectionChange={setSelectedElementId}
          onZoomChange={setZoomLevel}
          onToolReset={() => setSelectedTool('select')}
          onGestureEnd={undefined}
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
