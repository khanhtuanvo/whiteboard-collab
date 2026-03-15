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
  exportSVG: () => void;
  deleteSelected: () => void;
  clearSelection: () => void;
}

export interface CanvasProps {
  boardId: string;
  elements: Element[];
  onElementCreate: (element: Partial<Element>) => void;
  onElementUpdate: (id: string, updates: Partial<Element>) => void;
  onElementDelete: (id: string) => void;
  selectedTool: 'select' | 'rectangle' | 'circle' | 'text' | 'sticky_note' | 'pen' | 'line' | 'arrow';
  onSelectionChange?: (elementId: string | null) => void;
  onZoomChange?: (zoom: number) => void;
  /** Called with intermediate drag/move positions — no history recording */
  onElementDragUpdate?: (id: string, updates: Partial<Element>) => void;
  /** Called when the active drawing tool should reset to 'select' (after element creation) */
  onToolReset?: () => void;
  /** Called at the end of a discrete user gesture (drag end, resize end, text edit committed) */
  onGestureEnd?: () => void;
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
  onElementDragUpdate,
  onToolReset,
  onGestureEnd,
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

  // Tracks an element whose group was removed for in-canvas sticky editing
  const editingStickyIdRef = useRef<string | null>(null);

  // Tracks the optimistic UUID of the element just created locally so we can auto-select it on arrival
  const pendingSelectIdRef = useRef<string | null>(null);

  // Keep latest prop values in refs so stable callbacks never go stale
  const selectedToolRef = useRef(selectedTool);
  const elementsRef = useRef(elements);
  const boardIdRef = useRef(boardId);
  const onElementCreateRef = useRef(onElementCreate);
  const onElementUpdateRef = useRef(onElementUpdate);
  const onElementDeleteRef = useRef(onElementDelete);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onZoomChangeRef = useRef(onZoomChange);
  const onElementDragUpdateRef = useRef(onElementDragUpdate);
  const onToolResetRef = useRef(onToolReset);
  const onGestureEndRef = useRef(onGestureEnd);

  useEffect(() => { selectedToolRef.current = selectedTool; }, [selectedTool]);
  useEffect(() => { elementsRef.current = elements; }, [elements]);
  useEffect(() => { boardIdRef.current = boardId; }, [boardId]);
  useEffect(() => { onElementCreateRef.current = onElementCreate; }, [onElementCreate]);
  useEffect(() => { onElementUpdateRef.current = onElementUpdate; }, [onElementUpdate]);
  useEffect(() => { onElementDeleteRef.current = onElementDelete; }, [onElementDelete]);
  useEffect(() => { onSelectionChangeRef.current = onSelectionChange; }, [onSelectionChange]);
  useEffect(() => { onZoomChangeRef.current = onZoomChange; }, [onZoomChange]);
  useEffect(() => { onElementDragUpdateRef.current = onElementDragUpdate; }, [onElementDragUpdate]);
  useEffect(() => { onToolResetRef.current = onToolReset; }, [onToolReset]);
  useEffect(() => { onGestureEndRef.current = onGestureEnd; }, [onGestureEnd]);

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
      case ElementType.RECTANGLE: {
        const rScaleX = properties.scaleX ?? 1;
        const rScaleY = properties.scaleY ?? 1;
        return new fabric.Rect({
          ...base,
          left: properties.x,
          top: properties.y,
          width: (properties.width ?? 100) / Math.abs(rScaleX),
          height: (properties.height ?? 100) / Math.abs(rScaleY),
          scaleX: rScaleX,
          scaleY: rScaleY,
          fill: properties.fill ?? '#3b82f6',
          stroke: properties.stroke,
          strokeWidth: properties.strokeWidth ?? 0,
        });
      }

      case ElementType.CIRCLE:
        return new fabric.Circle({
          ...base,
          left: properties.x,
          top: properties.y,
          radius: properties.radius ?? 50,
          scaleX: properties.scaleX ?? 1,
          scaleY: properties.scaleY ?? 1,
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
        const snScaleX = properties.scaleX ?? 1;
        const snScaleY = properties.scaleY ?? 1;
        const w = (properties.width ?? 200) / Math.abs(snScaleX);
        const h = (properties.height ?? 200) / Math.abs(snScaleY);
        return new fabric.Group(
          [
            new fabric.Rect({
              width: w,
              height: h,
              fill: properties.fill ?? properties.color ?? '#fef08a',
              stroke: '#ca8a04',
              strokeWidth: 1,
            }),
            new fabric.Textbox(properties.text ?? 'Note', {
              fontSize: properties.fontSize ?? 16,
              fill: '#000000',
              width: w - 20,
              top: 10,
              left: 10,
            }),
          ],
          { ...base, left: properties.x, top: properties.y, scaleX: snScaleX, scaleY: snScaleY }
        );
      }

      case ElementType.LINE: {
        if (properties.pathData) {
          // Freehand pen path — path commands are in local coordinates
          return new fabric.Path(JSON.parse(properties.pathData), {
            ...base,
            left: properties.x,
            top: properties.y,
            stroke: properties.stroke ?? '#000000',
            strokeWidth: properties.strokeWidth ?? 3,
            fill: '',
          });
        }
        // Straight line stored as relative path "M 0 0 L dx dy"
        const dx = (properties.x2 ?? properties.x + 100) - properties.x;
        const dy = (properties.y2 ?? properties.y) - properties.y;
        return new fabric.Path(`M 0 0 L ${dx} ${dy}`, {
          ...base,
          left: properties.x,
          top: properties.y,
          stroke: properties.stroke ?? '#000000',
          strokeWidth: properties.strokeWidth ?? 2,
          fill: '',
          originX: 'left',
          originY: 'top',
        });
      }

      case ElementType.ARROW: {
        const dx = (properties.x2 ?? properties.x + 100) - properties.x;
        const dy = (properties.y2 ?? properties.y) - properties.y;
        const angle = Math.atan2(dy, dx);
        const arrowLen = 14;
        const ax1 = dx - arrowLen * Math.cos(angle - Math.PI / 6);
        const ay1 = dy - arrowLen * Math.sin(angle - Math.PI / 6);
        const ax2 = dx - arrowLen * Math.cos(angle + Math.PI / 6);
        const ay2 = dy - arrowLen * Math.sin(angle + Math.PI / 6);
        return new fabric.Path(
          `M 0 0 L ${dx} ${dy} M ${ax1} ${ay1} L ${dx} ${dy} L ${ax2} ${ay2}`,
          {
            ...base,
            left: properties.x,
            top: properties.y,
            stroke: properties.stroke ?? '#000000',
            strokeWidth: properties.strokeWidth ?? 2,
            fill: '',
            originX: 'left',
            originY: 'top',
          }
        );
      }

      default:
        return null;
    }
  }, []);

  // ─── Sticky-note in-canvas edit mode (shared by dblclick + auto-edit after creation) ──
  const enterStickyEditMode = useCallback((group: fabric.Group, elementId: string) => {
    const canvas = fabricCanvasRef.current;
    if (!canvas) return;

    const textObj = group.getObjects().find(o => o.type === 'i-text' || o.type === 'textbox') as fabric.IText | undefined;
    const rectObj = group.getObjects().find(o => o.type === 'rect') as fabric.Rect | undefined;
    if (!textObj) return;

    editingStickyIdRef.current = elementId;

    const gLeft = group.left ?? 0;
    const gTop = group.top ?? 0;
    const gScaleX = group.scaleX ?? 1;
    const gScaleY = group.scaleY ?? 1;
    const gW = (group.width ?? 200) * gScaleX;
    const gH = (group.height ?? 200) * gScaleY;

    canvas.remove(group);

    const bgRect = new fabric.Rect({
      left: gLeft,
      top: gTop,
      width: gW,
      height: gH,
      fill: (rectObj?.fill as string) ?? '#fef08a',
      stroke: '#ca8a04',
      strokeWidth: 1,
      selectable: false,
      evented: false,
    });

    // No data.elementId — prevents the global text:editing:exited handler from firing
    const standaloneText = new fabric.Textbox(textObj.text ?? '', {
      left: gLeft + 10,
      top: gTop + 10,
      fontSize: (textObj as any).fontSize ?? 16,
      fill: '#000000',
      width: gW - 20,
    });

    canvas.add(bgRect);
    canvas.add(standaloneText);
    canvas.setActiveObject(standaloneText);
    standaloneText.enterEditing();
    standaloneText.selectAll();

    standaloneText.once('editing:exited', () => {
      const newText = standaloneText.text ?? '';
      canvas.remove(standaloneText);
      canvas.remove(bgRect);
      editingStickyIdRef.current = null;

      const element = elementsRef.current.find(el => el.id === elementId);
      if (element) {
        onElementUpdateRef.current(elementId, {
          properties: { ...element.properties, text: newText },
        });
      }
      canvas.renderAll();
    });
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

    // Text / sticky tools: if the click lands on an existing object, bail out here.
    // Both clicks of a double-click will bail, preventing duplicate element creation.
    // The mouse:dblclick handler handles entering edit mode on existing elements.
    if (selectedToolRef.current === 'text' || selectedToolRef.current === 'sticky_note') {
      const canvas = fabricCanvasRef.current;
      if (canvas?.findTarget(e.e)) return;
    }

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

    // If a text element is in edit mode, swallow the create event entirely
    const activeObj = fabricCanvasRef.current?.getActiveObject();
    if ((activeObj as any)?.isEditing) {
      isDrawingRef.current = false;
      drawStartRef.current = null;
      return;
    }

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

      case 'line':
        elementData = {
          boardId: boardIdRef.current,
          type: ElementType.LINE,
          properties: { x: start.x, y: start.y, x2: pointer.x, y2: pointer.y, stroke: '#000000', strokeWidth: 2 },
          zIndex: 0,
        };
        break;

      case 'arrow':
        elementData = {
          boardId: boardIdRef.current,
          type: ElementType.ARROW,
          properties: { x: start.x, y: start.y, x2: pointer.x, y2: pointer.y, stroke: '#000000', strokeWidth: 2 },
          zIndex: 0,
        };
        break;

      default:
        isDrawingRef.current = false;
        drawStartRef.current = null;
        return;
    }

    // Generate a client-side UUID so we can identify this element when it arrives back from the server
    const optimisticId = crypto.randomUUID();
    elementData.id = optimisticId;
    pendingSelectIdRef.current = optimisticId;
    onElementCreateRef.current(elementData);
    onToolResetRef.current?.();
    isDrawingRef.current = false;
    drawStartRef.current = null;
  }, []);

  const handleObjectModified = useCallback((e: fabric.ModifiedEvent) => {
    if (!e.target) return;
    const obj = e.target;

    const emitUpdate = (child: fabric.Object) => {
      const elementId = (child as any).data?.elementId as string | undefined;
      if (!elementId) return;
      const element = elementsRef.current.find(el => el.id === elementId);
      if (!element) return;

      // Objects inside an ActiveSelection have group-relative coordinates;
      // use getBoundingRect() for absolute canvas coordinates.
      // Standalone objects: left/top are already absolute top-left (originX defaults to 'left').
      const isInGroup = (child as any).group?.type === 'activeSelection';
      let absLeft: number, absTop: number;
      if (isInGroup) {
        const br = child.getBoundingRect();
        absLeft = br.left;
        absTop = br.top;
      } else {
        absLeft = child.left ?? 0;
        absTop = child.top ?? 0;
      }

      onElementUpdateRef.current(elementId, {
        properties: {
          ...element.properties,
          x: absLeft,
          y: absTop,
          width: child.width!,        // raw base — never pre-multiplied by scale
          height: child.height!,      // raw base — never pre-multiplied by scale
          scaleX: child.scaleX ?? 1,
          scaleY: child.scaleY ?? 1,
        },
      });
    };

    if ((obj as any).type === 'activeSelection') {
      (obj as fabric.ActiveSelection).getObjects().forEach(emitUpdate);
    } else {
      emitUpdate(obj);
    }
  }, []);

  // ─── Init canvas once ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!canvasRef.current) return;

    const canvas = new fabric.Canvas(canvasRef.current, {
      width: window.innerWidth,
      height: window.innerHeight - HEADER_HEIGHT,
      backgroundColor: '#ffffff',
      selection: true,
      selectionColor: 'rgba(100, 130, 255, 0.15)',
      selectionBorderColor: '#6482ff',
      selectionLineWidth: 1,
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

      const emitOne = (child: fabric.Object) => {
        const elementId = (child as any).data?.elementId as string | undefined;
        if (!elementId) return;
        const element = elementsRef.current.find(el => el.id === elementId);
        if (!element) return;
        const t = child.calcTransformMatrix();
        // Use drag-only callback — broadcasts position for collaboration but does NOT record history
        onElementDragUpdateRef.current?.(elementId, {
          properties: {
            ...element.properties,
            x: t[4] - child.getScaledWidth() / 2,
            y: t[5] - child.getScaledHeight() / 2,
          },
        });
      };

      if ((obj as any).type === 'activeSelection') {
        (obj as fabric.ActiveSelection).getObjects().forEach(emitOne);
      } else {
        emitOne(obj);
      }
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

      // Don't intercept Delete/Backspace while an interactive element is focused
      const tag = (document.activeElement as HTMLElement)?.tagName;
      if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(tag)) return;

      // Delete / Backspace → delete selected element(s)
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const activeObj = canvas.getActiveObject();
        if (!activeObj) return;
        // Don't delete if editing text inside a Fabric IText
        if ((activeObj as any).isEditing) return;
        const activeObjects = canvas.getActiveObjects();
        const ids = activeObjects
          .map(o => (o as any).data?.elementId as string | undefined)
          .filter(Boolean) as string[];
        if (ids.length === 0) return;
        ids.forEach(id => onElementDeleteRef.current(id));
        canvas.discardActiveObject();
        canvas.renderAll();
        toast.success(ids.length > 1 ? `${ids.length} elements deleted` : 'Element deleted');
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

    // Double-click → enter edit mode on text / sticky note
    const handleDblClick = (e: fabric.TPointerEventInfo<MouseEvent>) => {
      const target = canvas.findTarget(e.e);
      if (!target) return;

      // Plain text (IText) — enter editing and save on exit
      if (target.type === 'i-text') {
        const itext = target as fabric.IText;
        const elementId = (itext as any).data?.elementId as string | undefined;
        canvas.setActiveObject(itext);
        itext.enterEditing();
        itext.once('editing:exited', () => {
          if (!elementId) return;
          const element = elementsRef.current.find(el => el.id === elementId);
          if (!element) return;
          onElementUpdateRef.current(elementId, {
            properties: { ...element.properties, text: itext.text ?? '' },
          });
        });
        return;
      }

      // Sticky note (Group) — delegate to shared helper
      if (target.type === 'group') {
        const group = target as fabric.Group;
        const elementId = (group as any).data?.elementId as string | undefined;
        if (!elementId) return;
        enterStickyEditMode(group, elementId);
      }
    };

    // Freehand pen: capture completed path and broadcast it as a LINE element
    const handlePathCreated = (e: any) => {
      const path = e.path as fabric.Path;
      if (!path || selectedToolRef.current !== 'pen') return;
      // Remove the fabric-managed path — the server round-trip will add it back
      canvas.remove(path);
      canvas.renderAll();
      const bounds = path.getBoundingRect();
      const penOptimisticId = crypto.randomUUID();
      pendingSelectIdRef.current = penOptimisticId;
      onElementCreateRef.current({
        id: penOptimisticId,
        boardId: boardIdRef.current,
        type: ElementType.LINE,
        properties: {
          x: bounds.left,
          y: bounds.top,
          pathData: JSON.stringify((path as any).path),
          stroke: (canvas.freeDrawingBrush as any)?.color ?? '#000000',
          strokeWidth: (canvas.freeDrawingBrush as any)?.width ?? 3,
        },
        zIndex: 0,
      });
      onToolResetRef.current?.();
    };

    canvas.on('mouse:down', handleMouseDown);
    canvas.on('mouse:move', handleMouseMove);
    canvas.on('mouse:up', handleMouseUp);
    canvas.on('mouse:dblclick', handleDblClick);
    canvas.on('object:modified', handleObjectModified);
    canvas.on('object:moving', emitMoving as any);
    canvas.on('mouse:wheel', handleWheel);
    canvas.on('selection:created', handleSelectionCreated);
    canvas.on('selection:updated', handleSelectionUpdated);
    canvas.on('selection:cleared', handleSelectionCleared);
    canvas.on('path:created', handlePathCreated);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      canvas.off('mouse:down', handleMouseDown);
      canvas.off('mouse:move', handleMouseMove);
      canvas.off('mouse:up', handleMouseUp);
      canvas.off('mouse:dblclick', handleDblClick);
      canvas.off('object:modified', handleObjectModified);
      canvas.off('object:moving', emitMoving as any);
      canvas.off('mouse:wheel', handleWheel);
      canvas.off('selection:created', handleSelectionCreated);
      canvas.off('selection:updated', handleSelectionUpdated);
      canvas.off('selection:cleared', handleSelectionCleared);
      canvas.off('path:created', handlePathCreated);
      canvas.dispose();
    };
  }, [handleMouseDown, handleMouseMove, handleMouseUp, handleObjectModified]);

  // ─── Sync tool mode ──────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = fabricCanvasRef.current;
    if (!canvas) return;
    const isSelect = selectedTool === 'select';
    const isPen = selectedTool === 'pen';
    // Enable Fabric's drawing mode only for the pen tool
    canvas.isDrawingMode = isPen;
    if (isPen) {
      const brush = new fabric.PencilBrush(canvas);
      brush.width = 3;
      brush.color = '#000000';
      canvas.freeDrawingBrush = brush;
    }
    // Marquee (rubber-band) selection only active in select mode
    canvas.selection = isSelect;
    // Objects are always individually selectable regardless of tool
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
      // Skip while its group has been removed for in-canvas sticky editing
      if (editingStickyIdRef.current === el.id) return;

      const existing = existingMap.get(el.id);
      if (!existing) {
        const obj = createFabricObject(el);
        if (obj) {
          canvas.add(obj);
          // Auto-select the element that was just created by the local user
          if (pendingSelectIdRef.current !== null && pendingSelectIdRef.current === el.id) {
            pendingSelectIdRef.current = null;
            canvas.setActiveObject(obj);
            onSelectionChangeRef.current?.(el.id);
            if (el.type === ElementType.TEXT) {
              // Enter edit mode immediately; 'editing:exited' listener will save text + call onGestureEnd
              const itext = obj as fabric.IText;
              itext.enterEditing();
              itext.selectAll();
              itext.once('editing:exited', () => {
                const element = elementsRef.current.find(e => e.id === el.id);
                if (!element) return;
                onElementUpdateRef.current(el.id, {
                  properties: { ...element.properties, text: itext.text ?? '' },
                });
              });
            } else if (el.type === ElementType.STICKY_NOTE) {
              // Defer one frame so the object is fully settled on the canvas
              requestAnimationFrame(() => enterStickyEditMode(obj as fabric.Group, el.id));
            }
          }
        }
      } else {
        // Apply style + position updates without recreating the object
        const p = el.properties;

        // For sticky notes (Group), the background color lives on the inner Rect,
        // not on the Group itself. Both `fill` (from ColorPicker) and `color`
        // (original property name) must be forwarded to that child Rect.
        if (existing.type === 'group') {
          const innerRect = (existing as fabric.Group)
            .getObjects()
            .find(o => o.type === 'rect') as fabric.Rect | undefined;
          // 1. Style on inner rect first
          const newFill = p.fill ?? p.color;
          if (innerRect && newFill !== undefined) innerRect.set('fill', newFill);
          if (p.strokeWidth !== undefined) innerRect?.set('strokeWidth', p.strokeWidth);
          // 2. Position
          if (p.x !== undefined) existing.set('left', p.x);
          if (p.y !== undefined) existing.set('top', p.y);
          // 3. Scale — must be applied BEFORE dimensions so the division below uses the new scale
          if (p.scaleX !== undefined) existing.set('scaleX', p.scaleX);
          if (p.scaleY !== undefined) existing.set('scaleY', p.scaleY);
          // 4. Base dimensions (divided by the now-current scale)
          if (p.width !== undefined) {
            (existing as any).set('width', p.width / Math.abs(p.scaleX ?? 1));
          }
          if (p.height !== undefined) {
            (existing as any).set('height', p.height / Math.abs(p.scaleY ?? 1));
          }
          // 5. Always last
          existing.setCoords();
        } else {
          // 1. Style
          if (p.fill !== undefined) existing.set('fill', p.fill);
          if (p.stroke !== undefined) existing.set('stroke', p.stroke);
          if (p.strokeWidth !== undefined) existing.set('strokeWidth', p.strokeWidth);
          if (p.fontSize !== undefined && (existing as any).fontSize !== undefined) {
            (existing as any).set('fontSize', p.fontSize);
          }
          // 2. Position
          if (p.x !== undefined) existing.set('left', p.x);
          if (p.y !== undefined) existing.set('top', p.y);
          // 3. Scale — must be applied BEFORE dimensions
          if (p.scaleX !== undefined) existing.set('scaleX', p.scaleX);
          if (p.scaleY !== undefined) existing.set('scaleY', p.scaleY);
          // 4. Base dimensions for rects (divided by the now-current scale)
          if (existing.type === 'rect') {
            if (p.width !== undefined) {
              (existing as any).set('width', p.width / Math.abs(p.scaleX ?? 1));
            }
            if (p.height !== undefined) {
              (existing as any).set('height', p.height / Math.abs(p.scaleY ?? 1));
            }
          }
          // 5. Always last
          existing.setCoords();
        }
      }
    });

    canvas.renderAll();
  }, [elements, createFabricObject, enterStickyEditMode]);

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
    exportSVG() {
      const canvas = fabricCanvasRef.current;
      if (!canvas) return;
      const svg = canvas.toSVG();
      const blob = new Blob([svg], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'whiteboard.svg';
      link.click();
      URL.revokeObjectURL(url);
    },
    deleteSelected() {
      const canvas = fabricCanvasRef.current;
      if (!canvas) return;
      const activeObj = canvas.getActiveObject();
      if (!activeObj || (activeObj as any).isEditing) return;
      const ids = canvas
        .getActiveObjects()
        .map(o => (o as any).data?.elementId as string | undefined)
        .filter(Boolean) as string[];
      if (ids.length === 0) return;
      ids.forEach(id => onElementDeleteRef.current(id));
      canvas.discardActiveObject();
      canvas.renderAll();
    },
    clearSelection() {
      const canvas = fabricCanvasRef.current;
      if (!canvas) return;
      // Cancel any in-progress shape creation
      isDrawingRef.current = false;
      drawStartRef.current = null;
      // Exit text editing if an object is currently being edited
      const activeObj = canvas.getActiveObject();
      if (activeObj && (activeObj as any).isEditing) {
        (activeObj as fabric.IText).exitEditing();
      }
      // Clear sticky note inline-edit state
      editingStickyIdRef.current = null;
      canvas.discardActiveObject();
      canvas.renderAll();
    },
  }));

  return (
    <div className="relative w-full h-full">
      <canvas ref={canvasRef} />
    </div>
  );
});

export default Canvas;
