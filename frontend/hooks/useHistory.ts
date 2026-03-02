'use client';

import { useState, useCallback } from 'react';

interface UseHistoryOptions {
  boardId: string;
  emitUndo: () => void;
  emitRedo: () => void;
}

export function useHistory({ boardId: _boardId, emitUndo, emitRedo }: UseHistoryOptions) {
  const [undoCount, setUndoCount] = useState(0);
  const [redoCount, setRedoCount] = useState(0);

  // Call this after every local element create/update/delete
  const recordAction = useCallback(() => {
    setUndoCount(c => c + 1);
    setRedoCount(0); // new action clears redo stack
  }, []);

  const undo = useCallback(() => {
    if (undoCount === 0) return;
    emitUndo();
    setUndoCount(c => Math.max(0, c - 1));
    setRedoCount(c => c + 1);
  }, [undoCount, emitUndo]);

  const redo = useCallback(() => {
    if (redoCount === 0) return;
    emitRedo();
    setRedoCount(c => Math.max(0, c - 1));
    setUndoCount(c => c + 1);
  }, [redoCount, emitRedo]);

  return {
    undo,
    redo,
    recordAction,
    canUndo: undoCount > 0,
    canRedo: redoCount > 0,
  };
}
