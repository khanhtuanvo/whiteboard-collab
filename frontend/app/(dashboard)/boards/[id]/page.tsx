'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { useUserStore } from '@/store/userStore';
import { boardService } from '@/lib/boardService';
import { Board } from '@/types/board';
import { Element } from '@/types/element';
import Toolbar from '@/components/board/Toolbar';

// Dynamic import to avoid SSR issues with Fabric.js
const Canvas = dynamic(() => import('@/components/board/Canvas'), {
  ssr: false,
});

export default function BoardPage() {
  const params = useParams();
  const router = useRouter();
  const user = useUserStore((state) => state.user);
  const boardId = params.id as string;

  const [board, setBoard] = useState<Board | null>(null);
  const [elements, setElements] = useState<Element[]>([]);
  const [selectedTool, setSelectedTool] = useState<string>('select');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) {
      router.push('/login');
      return;
    }

    loadBoard();
  }, [boardId, user, router]);

  const loadBoard = async () => {
    try {
      const boardData = await boardService.getBoard(boardId);
      setBoard(boardData);
      // TODO: Load elements from API
      setElements([]);
    } catch (error) {
      console.error('Failed to load board:', error);
      alert('Failed to load board');
      router.push('/boards');
    } finally {
      setLoading(false);
    }
  };

  const handleElementCreate = (element: Partial<Element>) => {
    console.log('Create element:', element);
    // TODO: Send to API via WebSocket
  };

  const handleElementUpdate = (id: string, updates: Partial<Element>) => {
    console.log('Update element:', id, updates);
    // TODO: Send to API via WebSocket
  };

  const handleElementDelete = (id: string) => {
    console.log('Delete element:', id);
    // TODO: Send to API via WebSocket
  };

  const handleUndo = () => {
    console.log('Undo');
    // TODO: Implement undo
  };

  const handleRedo = () => {
    console.log('Redo');
    // TODO: Implement redo
  };

  const handleExport = () => {
    console.log('Export');
    // TODO: Implement export
  };

  const handleShare = () => {
    console.log('Share');
    // TODO: Implement share
  };

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
      <div className="relative top-16">
        <Toolbar
          selectedTool={selectedTool}
          onToolSelect={setSelectedTool}
          onUndo={handleUndo}
          onRedo={handleRedo}
          onExport={handleExport}
          onShare={handleShare}
          canUndo={false}
          canRedo={false}
        />
      </div>

      {/* Canvas */}
      <div className="absolute top-16 left-0 right-0 bottom-0">
        <Canvas
          boardId={boardId}
          elements={elements}
          onElementCreate={handleElementCreate}
          onElementUpdate={handleElementUpdate}
          onElementDelete={handleElementDelete}
          selectedTool={selectedTool as any}
        />
      </div>
    </div>
  );
}