'use client';

import { useState } from 'react';
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
  Trash2,
  BringToFront,
  SendToBack,
  Eraser,
} from 'lucide-react';
import { Element, ElementType } from '@/types/element';

interface ToolbarProps {
  selectedTool: string;
  onToolSelect: (tool: string) => void;
  onUndo: () => void;
  onRedo: () => void;
  onExport: () => void;
  onShare: () => void;
  canUndo: boolean;
  canRedo: boolean;
  // Phase 1.5 additions
  selectedElement?: Element | null;
  onElementDelete?: (id: string) => void;
  onElementUpdate?: (id: string, updates: Partial<Element>) => void;
  zoomLevel?: number;
  elements?: Element[];
  // Phase 1.6 additions
  onClearAll?: () => void;
  onDeleteSelected?: () => void;
}

const STROKE_WIDTHS = [1, 3, 6];
const FONT_SIZES = [12, 16, 20, 24, 32, 48];

export default function Toolbar({
  selectedTool,
  onToolSelect,
  onUndo,
  onRedo,
  onExport,
  onShare,
  canUndo,
  canRedo,
  selectedElement,
  onElementDelete,
  onElementUpdate,
  zoomLevel,
  elements = [],
  onClearAll,
  onDeleteSelected,
}: ToolbarProps) {
  const [clearConfirm, setClearConfirm] = useState(false);
  const tools = [
    { id: 'select', icon: MousePointer2, label: 'Select' },
    { id: 'rectangle', icon: Square, label: 'Rectangle' },
    { id: 'circle', icon: Circle, label: 'Circle' },
    { id: 'text', icon: Type, label: 'Text' },
    { id: 'sticky_note', icon: StickyNote, label: 'Sticky Note' },
  ];

  const isTextType = selectedElement?.type === ElementType.TEXT || selectedElement?.type === ElementType.STICKY_NOTE;
  const currentStrokeWidth = selectedElement?.properties?.strokeWidth ?? 1;
  const currentFontSize = selectedElement?.properties?.fontSize ?? 16;
  const zoomPercent = zoomLevel != null ? Math.round(zoomLevel * 100) : 100;

  const handleBringToFront = () => {
    if (!selectedElement || !onElementUpdate) return;
    const maxZ = elements.length > 0 ? Math.max(...elements.map(e => e.zIndex)) : 0;
    onElementUpdate(selectedElement.id, { zIndex: maxZ + 1 });
  };

  const handleSendToBack = () => {
    if (!selectedElement || !onElementUpdate) return;
    const minZ = elements.length > 0 ? Math.min(...elements.map(e => e.zIndex)) : 0;
    onElementUpdate(selectedElement.id, { zIndex: minZ - 1 });
  };

  return (
    <div className="bg-white shadow-lg rounded-lg p-2 flex items-center gap-2 flex-wrap">
      {/* Drawing tools */}
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

      {/* Undo / Redo */}
      <Button variant="ghost" size="sm" onClick={onUndo} disabled={!canUndo} title="Undo (Ctrl+Z)">
        <Undo2 className="h-4 w-4" />
      </Button>
      <Button variant="ghost" size="sm" onClick={onRedo} disabled={!canRedo} title="Redo (Ctrl+Y)">
        <Redo2 className="h-4 w-4" />
      </Button>

      <Separator orientation="vertical" className="h-6" />

      {/* Export / Share */}
      <Button variant="ghost" size="sm" onClick={onExport} title="Export as PNG">
        <Download className="h-4 w-4" />
      </Button>
      <Button variant="ghost" size="sm" onClick={onShare} title="Share">
        <Share2 className="h-4 w-4" />
      </Button>

      {/* ── Selection-dependent controls ── */}
      {selectedElement && (
        <>
          <Separator orientation="vertical" className="h-6" />

          {/* Stroke width */}
          <div className="flex items-center gap-1">
            <span className="text-xs text-gray-500">Stroke</span>
            {STROKE_WIDTHS.map(w => (
              <button
                key={w}
                title={`${w}px`}
                onClick={() => onElementUpdate?.(selectedElement.id, {
                  properties: { ...selectedElement.properties, strokeWidth: w },
                })}
                className={`px-2 py-0.5 text-xs rounded border transition-colors ${
                  currentStrokeWidth === w
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'border-gray-200 hover:bg-gray-100'
                }`}
              >
                {w}
              </button>
            ))}
          </div>

          {/* Font size — text/sticky only */}
          {isTextType && (
            <div className="flex items-center gap-1">
              <span className="text-xs text-gray-500">Size</span>
              <select
                className="border rounded px-1 py-0.5 text-xs"
                value={currentFontSize}
                onChange={e => onElementUpdate?.(selectedElement.id, {
                  properties: { ...selectedElement.properties, fontSize: Number(e.target.value) },
                })}
              >
                {FONT_SIZES.map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
          )}

          {/* Z-index */}
          <Button variant="ghost" size="sm" onClick={handleBringToFront} title="Bring to Front">
            <BringToFront className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={handleSendToBack} title="Send to Back">
            <SendToBack className="h-4 w-4" />
          </Button>

          {/* Delete — uses deleteSelected() so multi-select works correctly */}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onDeleteSelected ? onDeleteSelected() : onElementDelete?.(selectedElement.id)}
            title="Delete (Del)"
            className="text-red-500 hover:text-red-700 hover:bg-red-50"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </>
      )}

      {/* Zoom level — always visible */}
      <Separator orientation="vertical" className="h-6" />
      <span className="text-xs text-gray-500 min-w-[3rem] text-center" title="Zoom level">
        {zoomPercent}%
      </span>

      {/* Clear All */}
      <Separator orientation="vertical" className="h-6" />
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setClearConfirm(true)}
        title="Clear All"
        className="text-red-500 hover:text-red-700 hover:bg-red-50"
      >
        <Eraser className="h-4 w-4" />
      </Button>

      {/* Confirmation dialog */}
      {clearConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-lg shadow-xl p-6 w-80">
            <h2 className="text-base font-semibold mb-2">Clear all elements?</h2>
            <p className="text-sm text-gray-500 mb-4">
              This will permanently delete every element on the board for all collaborators.
            </p>
            <div className="flex justify-end gap-2">
              <button
                className="px-4 py-2 text-sm rounded border hover:bg-gray-50"
                onClick={() => setClearConfirm(false)}
              >
                Cancel
              </button>
              <button
                className="px-4 py-2 text-sm rounded bg-red-600 text-white hover:bg-red-700"
                onClick={() => { onClearAll?.(); setClearConfirm(false); }}
              >
                Clear All
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
