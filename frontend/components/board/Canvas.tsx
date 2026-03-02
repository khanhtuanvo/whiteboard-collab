'use client';

import { useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from 'react';
import * as fabric from 'fabric';
import { toast } from 'sonner';
import { Element, ElementType } from '@/types/element';

const HEADER_HEIGHT = 64;
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 5.0;
const THROTTLE_MS = 33; // ~30fps

function throttleFn<T extends (...args: any[]) => any>(fn: T, ms: number): T {
  let last = 0;
  return ((...args: any[]) => {
    const now = Date.now();
    if (now - last >= ms) { last = now; fn(...args); }
  }) as T;
}

export interface CanvasHandle {
  exportImage: () => void;
}

export interface CanvasProps {
  boardId: string;
  elements: Element[];
  onElementCreate: (element: Partial<Element>) => void;
  onElementUpdate: (id: string, updates: Partial<Element>) => void;
  onElementDelete: (id: string) => void;
  selectedTool: 'select' | 'rectangle' | 'circle' | 'text' | 'sticky_note';
  onSelectionChange?: (elementId: string | null) => void;
  onZoomChange?: (zoom: number) => void;
}

const Canvas = forwardRef<CanvasHandle, CanvasProps>(function Canvas({
  boardId,
  elements,
  onElementCreate,
  onElementUpdate,
  onElementDelete,
  selectedTool,
  onSelectionChange,
  onZoomChange,
}: CanvasProps, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fabricCanvasRef = useRef<fabric.Canvas | null>(null);

  // Drawing state
  const isDrawingRef = useRef(false);
  const drawStartRef = useRef<{ x: number; y: number } | null>(null);

  // Pan state
  const isPanningRef = useRef(false);
  const panStartRef = useRef<{ x: number; y: number } | null>(null);
  const spaceHeldRef = useRef(false);

  // Copy/paste clipboard
  const clipboardRef = useRef<{ elementId: string } | null>(null);

  // Keep latest prop values in refs so stable callbacks never go stale
  const selectedToolRef = useRef(selectedTool);
  const elementsRef = useRef(elements);
  const boardIdRef = useRef(boardId);
  const onElementCreateRef = useRef(onElementCreate);
  const onElementUpdateRef = useRef(onElementUpdate);
  const onElementDeleteRef = useRef(onElementDelete);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onZoomChangeRef = useRef(onZoomChange);

  useEffect(() => { selectedToolRef.current = selectedTool; }, [selectedTool]);
  useEffect(() => { elementsRef.current = elements; }, [elements]);
  useEffect(() => { boardIdRef.current = boardId; }, [boardId]);
  useEffect(() => { onElementCreateRef.current = onElementCreate; }, [onElementCreate]);
  useEffect(() => { onElementUpdateRef.current = onElementUpdate; }, [onElementUpdate]);
  useEffect(() => { onElementDeleteRef.current = onElementDelete; }, [onElementDelete]);
  useEffect(() => { onSelectionChangeRef.current = onSelectionChange; }, [onSelectionChange]);
  useEffect(() => { onZoomChangeRef.current = onZoomChange; }, [onZoomChange]);

  // ─── Create a Fabric object from element data ───────────────────────────────
  const createFabricObject = useCallback((element: Element): fabric.Object | null => {
    const { type, properties } = element;

    const base = {
      data: { elementId: element.id },
      hasControls: true,
      hasBorders: true,
      selectable: true,
    };

    switch (type) {
      case ElementType.RECTANGLE:
        return new fabric.Rect({
          ...base,
          left: properties.x,
          top: properties.y,
          width: properties.width ?? 100,
          height: properties.height ?? 100,
          fill: properties.fill ?? '#3b82f6',
          stroke: properties.stroke,
          strokeWidth: properties.strokeWidth ?? 0,
        });

      case ElementType.CIRCLE:
        return new fabric.Circle({
          ...base,
          left: properties.x,
          top: properties.y,
          radius: properties.radius ?? 50,
          fill: properties.fill ?? '#10b981',
          stroke: properties.stroke,
          strokeWidth: properties.strokeWidth ?? 0,
        });

      case ElementType.TEXT:
        return new fabric.IText(properties.text ?? 'Text', {
          ...base,
          left: properties.x,
          top: properties.y,
          fontSize: properties.fontSize ?? 20,
          fill: properties.color ?? '#000000',
        });

      case ElementType.STICKY_NOTE: {
        const w = properties.width ?? 200;
        const h = properties.height ?? 200;
        return new fabric.Group(
          [
            new fabric.Rect({
              width: w,
              height: h,
              fill: properties.color ?? '#fef08a',
              stroke: '#ca8a04',
              strokeWidth: 1,
            }),
            new fabric.IText(properties.text ?? 'Note', {
              fontSize: properties.fontSize ?? 16,
              fill: '#000000',
              width: w - 20,
              top: 10,
              left: 10,
            }),
          ],
          { ...base, left: properties.x, top: properties.y }
        );
      }

      default:
        return null;
    }
  }, []);

  // ─── Stable mouse handlers (read from refs, never go stale) ─────────────────
  const handleMouseDown = useCallback((e: fabric.TPointerEventInfo) => {
    const me = e.e as MouseEvent;

    // Middle mouse button → start panning
    if (me.button === 1) {
      isPanningRef.current = true;
      panStartRef.current = { x: me.clientX, y: me.clientY };
      me.preventDefault();
      return;
    }

    // Space held + left click → start panning
    if (spaceHeldRef.current) {
      isPanningRef.current = true;
      panStartRef.current = { x: me.clientX, y: me.clientY };
      return;
    }

    if (selectedToolRef.current === 'select') return;

    const pointer = fabricCanvasRef.current?.getScenePoint(e.e);
    if (!pointer) return;
    isDrawingRef.current = true;
    drawStartRef.current = { x: pointer.x, y: pointer.y };
  }, []);

  const handleMouseMove = useCallback((e: fabric.TPointerEventInfo) => {
    if (!isPanningRef.current || !panStartRef.current) return;
    const canvas = fabricCanvasRef.current;
    if (!canvas) return;
    const me = e.e as MouseEvent;
    const dx = me.clientX - panStartRef.current.x;
    const dy = me.clientY - panStartRef.current.y;
    panStartRef.current = { x: me.clientX, y: me.clientY };
    canvas.relativePan(new fabric.Point(dx, dy));
  }, []);

  const handleMouseUp = useCallback((e: fabric.TPointerEventInfo) => {
    if (isPanningRef.current) {
      isPanningRef.current = false;
      panStartRef.current = null;
      return;
    }

    if (!isDrawingRef.current || !drawStartRef.current) return;

    const pointer = fabricCanvasRef.current?.getScenePoint(e.e);
    if (!pointer) return;

    const start = drawStartRef.current;
    const w = Math.abs(pointer.x - start.x);
    const h = Math.abs(pointer.y - start.y);
    const x = Math.min(start.x, pointer.x);
    const y = Math.min(start.y, pointer.y);
    const tool = selectedToolRef.current;

    if (w < 2 && h < 2 && tool !== 'text' && tool !== 'sticky_note') {
      isDrawingRef.current = false;
      drawStartRef.current = null;
      return;
    }

    let elementData: Partial<Element>;

    switch (tool) {
      case 'rectangle':
        elementData = {
          boardId: boardIdRef.current,
          type: ElementType.RECTANGLE,
          properties: { x, y, width: w, height: h, fill: '#3b82f6' },
          zIndex: 0,
        };
        break;

      case 'circle':
        elementData = {
          boardId: boardIdRef.current,
          type: ElementType.CIRCLE,
          properties: { x: start.x, y: start.y, radius: Math.max(w, h) / 2, fill: '#10b981' },
          zIndex: 0,
        };
        break;

      case 'text':
        elementData = {
          boardId: boardIdRef.current,
          type: ElementType.TEXT,
          properties: { x: start.x, y: start.y, text: 'Double click to edit', fontSize: 20, color: '#000000' },
          zIndex: 0,
        };
        break;

      case 'sticky_note':
        elementData = {
          boardId: boardIdRef.current,
          type: ElementType.STICKY_NOTE,
          properties: { x: start.x, y: start.y, width: 200, height: 200, text: 'New note', color: '#fef08a' },
          zIndex: 0,
        };
        break;

      default:
        isDrawingRef.current = false;
        drawStartRef.current = null;
        return;
    }

    onElementCreateRef.current(elementData);
    isDrawingRef.current = false;
    drawStartRef.current = null;
  }, []);

  const handleObjectModified = useCallback((e: fabric.ModifiedEvent) => {
    if (!e.target) return;
    const obj = e.target;
    const elementId = (obj as any).data?.elementId as string | undefined;
    if (!elementId) return;

    const element = elementsRef.current.find(el => el.id === elementId);
    if (!element) return;

    onElementUpdateRef.current(elementId, {
      properties: {
        ...element.properties,
        x: obj.left ?? 0,
        y: obj.top ?? 0,
        width: obj.getScaledWidth(),
        height: obj.getScaledHeight(),
        scaleX: obj.scaleX ?? 1,
        scaleY: obj.scaleY ?? 1,
      },
    });
  }, []);

  // ─── Init canvas once ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!canvasRef.current) return;

    const canvas = new fabric.Canvas(canvasRef.current, {
      width: window.innerWidth,
      height: window.innerHeight - HEADER_HEIGHT,
      backgroundColor: '#ffffff',
    });
    fabricCanvasRef.current = canvas;

    const handleResize = () => {
      canvas.setDimensions({
        width: window.innerWidth,
        height: window.innerHeight - HEADER_HEIGHT,
      });
      canvas.renderAll();
    };
    window.addEventListener('resize', handleResize);

    // Throttled live-move emitter (fires while dragging, not just on mouse-up)
    const emitMoving = throttleFn((e: { target: fabric.Object }) => {
      const obj = e.target;
      if (!obj) return;
      const elementId = (obj as any).data?.elementId as string | undefined;
      if (!elementId) return;
      const element = elementsRef.current.find(el => el.id === elementId);
      if (!element) return;
      onElementUpdateRef.current(elementId, {
        properties: {
          ...element.properties,
          x: obj.left ?? 0,
          y: obj.top ?? 0,
        },
      });
    }, THROTTLE_MS);

    // Zoom with mouse wheel
    const handleWheel = (opt: fabric.TPointerEventInfo<WheelEvent>) => {
      const delta = opt.e.deltaY;
      let zoom = canvas.getZoom();
      zoom *= 0.999 ** delta;
      zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
      canvas.zoomToPoint(new fabric.Point(opt.e.offsetX, opt.e.offsetY), zoom);
      opt.e.preventDefault();
      opt.e.stopPropagation();
      onZoomChangeRef.current?.(zoom);
    };

    // Selection tracking
    const handleSelectionCreated = (e: any) => {
      const obj = e.selected?.[0];
      const elementId = (obj as any)?.data?.elementId as string | undefined;
      onSelectionChangeRef.current?.(elementId ?? null);
    };
    const handleSelectionUpdated = (e: any) => {
      const obj = e.selected?.[0];
      const elementId = (obj as any)?.data?.elementId as string | undefined;
      onSelectionChangeRef.current?.(elementId ?? null);
    };
    const handleSelectionCleared = () => {
      onSelectionChangeRef.current?.(null);
    };

    // Keyboard handlers
    const handleKeyDown = (e: KeyboardEvent) => {
      // Space → grab/pan cursor
      if (e.code === 'Space' && !e.repeat) {
        spaceHeldRef.current = true;
        canvas.defaultCursor = 'grab';
        canvas.renderAll();
        return;
      }

      // ESC → deselect
      if (e.key === 'Escape') {
        canvas.discardActiveObject();
        canvas.renderAll();
        onSelectionChangeRef.current?.(null);
        return;
      }

      // Don't intercept Delete/Backspace while typing in inputs
      const tag = (document.activeElement as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      // Delete / Backspace → delete selected element
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const obj = canvas.getActiveObject();
        if (!obj) return;
        // Don't delete if editing text inside a Fabric IText
        if ((obj as any).isEditing) return;
        const elementId = (obj as any).data?.elementId as string | undefined;
        if (!elementId) return;
        onElementDeleteRef.current(elementId);
        toast.success('Element deleted');
        return;
      }

      // Ctrl+C → copy
      if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        const obj = canvas.getActiveObject();
        if (!obj) return;
        const elementId = (obj as any).data?.elementId as string | undefined;
        if (elementId) clipboardRef.current = { elementId };
        return;
      }

      // Ctrl+V → paste with +20 offset
      if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
        if (!clipboardRef.current) return;
        const { elementId } = clipboardRef.current;
        const element = elementsRef.current.find(el => el.id === elementId);
        if (!element) return;
        onElementCreateRef.current({
          boardId: boardIdRef.current,
          type: element.type,
          properties: {
            ...element.properties,
            x: (element.properties.x ?? 0) + 20,
            y: (element.properties.y ?? 0) + 20,
          },
          zIndex: element.zIndex,
        });
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceHeldRef.current = false;
        canvas.defaultCursor = selectedToolRef.current === 'select' ? 'default' : 'crosshair';
        canvas.renderAll();
      }
    };

    canvas.on('mouse:down', handleMouseDown);
    canvas.on('mouse:move', handleMouseMove);
    canvas.on('mouse:up', handleMouseUp);
    canvas.on('object:modified', handleObjectModified);
    canvas.on('object:moving', emitMoving as any);
    canvas.on('mouse:wheel', handleWheel);
    canvas.on('selection:created', handleSelectionCreated);
    canvas.on('selection:updated', handleSelectionUpdated);
    canvas.on('selection:cleared', handleSelectionCleared);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      canvas.off('mouse:down', handleMouseDown);
      canvas.off('mouse:move', handleMouseMove);
      canvas.off('mouse:up', handleMouseUp);
      canvas.off('object:modified', handleObjectModified);
      canvas.off('object:moving', emitMoving as any);
      canvas.off('mouse:wheel', handleWheel);
      canvas.off('selection:created', handleSelectionCreated);
      canvas.off('selection:updated', handleSelectionUpdated);
      canvas.off('selection:cleared', handleSelectionCleared);
      canvas.dispose();
    };
  }, [handleMouseDown, handleMouseMove, handleMouseUp, handleObjectModified]);

  // ─── Sync tool mode ──────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = fabricCanvasRef.current;
    if (!canvas) return;
    const isSelect = selectedTool === 'select';
    canvas.isDrawingMode = false;
    canvas.selection = isSelect;
    // Objects are always selectable; in draw mode the cursor changes but objects still respond
    canvas.forEachObject(obj => { obj.selectable = true; });
    canvas.defaultCursor = isSelect ? 'default' : 'crosshair';
    canvas.renderAll();
  }, [selectedTool]);

  // ─── Sync elements: diff instead of full clear+redraw ───────────────────────
  useEffect(() => {
    const canvas = fabricCanvasRef.current;
    if (!canvas) return;

    const existingObjects = canvas.getObjects();

    const existingMap = new Map<string, fabric.Object>();
    existingObjects.forEach(obj => {
      const id = (obj as any).data?.elementId;
      if (id) existingMap.set(id, obj);
    });

    const incomingIds = new Set(elements.map(el => el.id));

    // Remove objects that no longer exist
    existingMap.forEach((obj, id) => {
      if (!incomingIds.has(id)) canvas.remove(obj);
    });

    // Add new elements; update fill/stroke/fontSize on existing ones
    elements.forEach(el => {
      const existing = existingMap.get(el.id);
      if (!existing) {
        const obj = createFabricObject(el);
        if (obj) canvas.add(obj);
      } else {
        // Apply style updates without recreating the object
        const p = el.properties;
        if (p.fill !== undefined) existing.set('fill', p.fill);
        if (p.stroke !== undefined) existing.set('stroke', p.stroke);
        if (p.strokeWidth !== undefined) existing.set('strokeWidth', p.strokeWidth);
        if (p.fontSize !== undefined && (existing as any).fontSize !== undefined) {
          (existing as any).set('fontSize', p.fontSize);
        }
      }
    });

    canvas.renderAll();
  }, [elements, createFabricObject]);

  useImperativeHandle(ref, () => ({
    exportImage() {
      const canvas = fabricCanvasRef.current;
      if (!canvas) return;
      const dataURL = canvas.toDataURL({ multiplier: 1, format: 'png', quality: 1 });
      const link = document.createElement('a');
      link.href = dataURL;
      link.download = 'whiteboard.png';
      link.click();
    },
  }));

  return (
    <div className="relative w-full h-full">
      <canvas ref={canvasRef} />
    </div>
  );
});

export default Canvas;
