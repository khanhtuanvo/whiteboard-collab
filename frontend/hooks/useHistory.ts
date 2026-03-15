'use client';

import { useState, useCallback } from 'react';

interface UseHistoryOptions {
  boardId: string;
  emitUndo: () => void;
  emitRedo: () => void;
  onBeforeUndoRedo?: () => void;
}

export function useHistory({ boardId: _boardId, emitUndo, emitRedo, onBeforeUndoRedo }: UseHistoryOptions) {
  // C3: canUndo/canRedo are driven entirely by server-reported stack depths
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  /** Called whenever the server emits history:state */
  const setHistoryState = useCallback((undoDepth: number, redoDepth: number) => {
    setCanUndo(undoDepth > 0);
    setCanRedo(redoDepth > 0);
  }, []);

  const undo = useCallback(() => {
    if (!canUndo) return;
    onBeforeUndoRedo?.();
    emitUndo();
  }, [canUndo, emitUndo, onBeforeUndoRedo]);

  const redo = useCallback(() => {
    if (!canRedo) return;
    onBeforeUndoRedo?.();
    emitRedo();
  }, [canRedo, emitRedo, onBeforeUndoRedo]);

  return {
    undo,
    redo,
    setHistoryState,
    canUndo,
    canRedo,
  };
}
