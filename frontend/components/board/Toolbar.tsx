'use client';

import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  MousePointer2,
  Square,
  Circle,
  Type,
  StickyNote,
  Undo2,
  Redo2,
  Download,
  Share2,
} from 'lucide-react';

interface ToolbarProps {
  selectedTool: string;
  onToolSelect: (tool: string) => void;
  onUndo: () => void;
  onRedo: () => void;
  onExport: () => void;
  onShare: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

export default function Toolbar({
  selectedTool,
  onToolSelect,
  onUndo,
  onRedo,
  onExport,
  onShare,
  canUndo,
  canRedo,
}: ToolbarProps) {
  const tools = [
    { id: 'select', icon: MousePointer2, label: 'Select' },
    { id: 'rectangle', icon: Square, label: 'Rectangle' },
    { id: 'circle', icon: Circle, label: 'Circle' },
    { id: 'text', icon: Type, label: 'Text' },
    { id: 'sticky_note', icon: StickyNote, label: 'Sticky Note' },
  ];

  return (
    <div className="absolute top-4 left-1/2 transform -translate-x-1/2 bg-white shadow-lg rounded-lg p-2 flex items-center gap-2 z-10">
      {tools.map((tool) => (
        <Button
          key={tool.id}
          variant={selectedTool === tool.id ? 'default' : 'ghost'}
          size="sm"
          onClick={() => onToolSelect(tool.id)}
          title={tool.label}
        >
          <tool.icon className="h-4 w-4" />
        </Button>
      ))}

      <Separator orientation="vertical" className="h-6" />

      <Button
        variant="ghost"
        size="sm"
        onClick={onUndo}
        disabled={!canUndo}
        title="Undo"
      >
        <Undo2 className="h-4 w-4" />
      </Button>

      <Button
        variant="ghost"
        size="sm"
        onClick={onRedo}
        disabled={!canRedo}
        title="Redo"
      >
        <Redo2 className="h-4 w-4" />
      </Button>

      <Separator orientation="vertical" className="h-6" />

      <Button
        variant="ghost"
        size="sm"
        onClick={onExport}
        title="Export"
      >
        <Download className="h-4 w-4" />
      </Button>

      <Button
        variant="ghost"
        size="sm"
        onClick={onShare}
        title="Share"
      >
        <Share2 className="h-4 w-4" />
      </Button>
    </div>
  );
}