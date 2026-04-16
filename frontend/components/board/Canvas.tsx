'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from 'react';
import * as fabric from 'fabric';
import { toast } from 'sonner';
import { Element, ElementType } from '@/types/element';
import { buildTransformUpdates, normalizeScale, resolveSyncBaseDimensions } from './canvasTransform';

const HEADER_HEIGHT = 64;
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 5.0;
const THROTTLE_MS = 40; // ~25fps, keeps headroom for final commit events

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
  const previewObjectRef = useRef<fabric.Object | null>(null);

  // Pan state
  const isPanningRef = useRef(false);
  const panStartRef = useRef<{ x: number; y: number } | null>(null);
  const spaceHeldRef = useRef(false);

  // Copy/paste clipboard — holds one or more element IDs for multi-select support
  const clipboardRef = useRef<{ elementIds: string[] } | null>(null);

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

  interface RenderSafeFabricNode {
    scaleX?: number;
    scaleY?: number;
    width?: number;
    height?: number;
    dirty?: boolean;
    _cacheCanvas?: { width: number; height: number };
    getObjects?: () => fabric.Object[];
  }

  const hardenFabricObjectForRender = useCallback((obj: fabric.Object) => {
    const node = obj as unknown as RenderSafeFabricNode;

    obj.set('objectCaching', false);

    const scaleX = normalizeScale(node.scaleX, 1);
    const scaleY = normalizeScale(node.scaleY, 1);
    if (node.scaleX !== scaleX) obj.set('scaleX', scaleX);
    if (node.scaleY !== scaleY) obj.set('scaleY', scaleY);

    if (typeof node.width === 'number' && Number.isFinite(node.width) && node.width <= 0) {
      obj.set('width', 1);
    }
    if (typeof node.height === 'number' && Number.isFinite(node.height) && node.height <= 0) {
      obj.set('height', 1);
    }

    const cacheCanvas = node._cacheCanvas;
    if (cacheCanvas && (cacheCanvas.width <= 0 || cacheCanvas.height <= 0)) {
      node._cacheCanvas = undefined;
      node.dirty = true;
    }

    if (typeof node.getObjects === 'function') {
      (node.getObjects() as fabric.Object[]).forEach((child: fabric.Object) => {
        hardenFabricObjectForRender(child);
      });
    }
  }, []);

  const safeRenderCanvas = useCallback((canvas: fabric.Canvas, reason: string) => {
    canvas.getObjects().forEach((obj: fabric.Object) => hardenFabricObjectForRender(obj));

    try {
      canvas.renderAll();
    } catch (err) {
      // Extra recovery pass for stale internals that still hold invalid cache buffers.
      canvas.getObjects().forEach((obj: fabric.Object) => {
        hardenFabricObjectForRender(obj);
        (obj as unknown as RenderSafeFabricNode).dirty = true;
      });

      try {
        canvas.requestRenderAll();
      } catch {
        // Keep UI responsive even if Fabric rejects a frame; next sync pass can recover.
      }
      console.error(`[Canvas] safeRender recovered from cache-size error (${reason})`, err);
    }
  }, [hardenFabricObjectForRender]);

  // ─── Create a Fabric object from element data ───────────────────────────────
  const createFabricObject = useCallback((element: Element): fabric.Object | null => {
    const { type, properties } = element;

    const base = {
      data: { elementId: element.id },
      hasControls: true,
      hasBorders: true,
      selectable: true,
      objectCaching: false,
    };

    switch (type) {
      case ElementType.RECTANGLE: {
        const rScaleX = normalizeScale(properties.scaleX, 1);
        const rScaleY = normalizeScale(properties.scaleY, 1);
        return new fabric.Rect({
          ...base,
          left: properties.x,
          top: properties.y,
          width: resolveSyncBaseDimensions({ width: properties.width, currentWidth: 100 }).width,
          height: resolveSyncBaseDimensions({ height: properties.height, currentHeight: 100 }).height,
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
          scaleX: normalizeScale(properties.scaleX, 1),
          scaleY: normalizeScale(properties.scaleY, 1),
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
        const snScaleX = normalizeScale(properties.scaleX, 1);
        const snScaleY = normalizeScale(properties.scaleY, 1);
        const dims = resolveSyncBaseDimensions({
          width: properties.width,
          height: properties.height,
          currentWidth: 200,
          currentHeight: 200,
        });
        const w = dims.width;
        const h = dims.height;
        return new fabric.Group(
          [
            new fabric.Rect({
              width: w,
              height: h,
              fill: properties.fill ?? properties.color ?? '#fef08a',
              stroke: '#ca8a04',
              strokeWidth: 1,
              objectCaching: false,
            }),
            new fabric.Textbox(properties.text ?? '', {
              fontSize: properties.fontSize ?? 16,
              fill: '#000000',
              width: Math.max(20, w - 20),
              top: 10,
              left: 10,
              objectCaching: false,
              // Break at any character so long words (or text with no spaces) never
              // overflow the note boundary horizontally.
              splitByGrapheme: true,
            }),
          ],
          { ...base, left: properties.x, top: properties.y, scaleX: snScaleX, scaleY: snScaleY }
        );
      }

      case ElementType.LINE: {
        if (properties.pathData) {
          // Freehand pen path — path commands are in local coordinates
           
          let parsedPath: any;
          try {
            parsedPath = JSON.parse(properties.pathData);
          } catch {
            console.error('[Canvas] Malformed pathData for element', element.id);
            return null;
          }
          // parsedPath is TComplexPathData at runtime; cast suppresses the unknown-type error
          return new fabric.Path(parsedPath as string, {
            ...base,
            left: properties.x,
            top: properties.y,
            scaleX: normalizeScale(properties.scaleX, 1),
            scaleY: normalizeScale(properties.scaleY, 1),
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
          scaleX: normalizeScale(properties.scaleX, 1),
          scaleY: normalizeScale(properties.scaleY, 1),
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
            scaleX: normalizeScale(properties.scaleX, 1),
            scaleY: normalizeScale(properties.scaleY, 1),
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
    const gW = Math.max(1, (group.width ?? 200) * gScaleX);
    const gH = Math.max(1, (group.height ?? 200) * gScaleY);

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
      objectCaching: false,
    });

    // No data.elementId — prevents the global text:editing:exited handler from firing
    const standaloneText = new fabric.Textbox(textObj.text ?? '', {
      left: gLeft + 10,
      top: gTop + 10,
      fontSize: (textObj as any).fontSize ?? 16,
      fill: '#000000',
      // Keep the textbox exactly as wide as the note interior so text wraps before
      // reaching the note edge regardless of whether the input has spaces or not.
      width: Math.max(20, gW - 20),
      objectCaching: false,
      // Character-level wrapping so long words / no-space input can't overflow
      // horizontally past the note boundary.
      splitByGrapheme: true,
    });

    canvas.add(bgRect);
    canvas.add(standaloneText);
    canvas.setActiveObject(standaloneText);
    standaloneText.enterEditing();
    standaloneText.selectAll();

    // Auto-grow the background rect as the user types long content so text
    // never visually overflows the sticky note boundary.
    const onTextChanged = () => {
      const textH = standaloneText.height ?? 0;
      const needed = Math.max(gH, textH + 20);
      if ((bgRect.height ?? gH) !== needed) {
        bgRect.set({ height: needed });
        safeRenderCanvas(canvas, 'sticky-text-grow');
      }
    };
    standaloneText.on('changed', onTextChanged);

    standaloneText.once('editing:exited', () => {
      standaloneText.off('changed', onTextChanged);
      const newText = standaloneText.text ?? '';
      // Capture the final bgRect height BEFORE removing it so we can persist it.
      const finalBgHeight = bgRect.height ?? gH;
      canvas.remove(standaloneText);
      canvas.remove(bgRect);
      editingStickyIdRef.current = null;

      const element = elementsRef.current.find(el => el.id === elementId);
      if (element) {
        onElementUpdateRef.current(elementId, {
          properties: {
            ...element.properties,
            text: newText,
            // Persist auto-grown height as unscaled base dimension so it
            // survives a round-trip through the server and createFabricObject.
            height: Math.round(finalBgHeight / gScaleY),
          },
        });
      }
      onGestureEndRef.current?.();
      safeRenderCanvas(canvas, 'sticky-edit-exit');
    });
  }, [safeRenderCanvas]);

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
      // Suppress mousedown while the element created by the previous click hasn't
      // arrived from the server yet — correct regardless of network latency.
      if (pendingSelectIdRef.current !== null) return;
      const canvas = fabricCanvasRef.current;
      if (canvas?.findTarget(e.e)) return;
    }

    const pointer = fabricCanvasRef.current?.getScenePoint(e.e);
    if (!pointer) return;
    isDrawingRef.current = true;
    drawStartRef.current = { x: pointer.x, y: pointer.y };
  }, []);

  const handleMouseMove = useCallback((e: fabric.TPointerEventInfo) => {
    const canvas = fabricCanvasRef.current;
    if (!canvas) return;

    // Panning
    if (isPanningRef.current && panStartRef.current) {
      const me = e.e as MouseEvent;
      const dx = me.clientX - panStartRef.current.x;
      const dy = me.clientY - panStartRef.current.y;
      panStartRef.current = { x: me.clientX, y: me.clientY };
      canvas.relativePan(new fabric.Point(dx, dy));
      return;
    }

    // Drawing preview (rubber-band ghost shape)
    if (!isDrawingRef.current || !drawStartRef.current) return;
    const tool = selectedToolRef.current;
    if (tool === 'select' || tool === 'pen') return;

    const pointer = canvas.getScenePoint(e.e);
    const start = drawStartRef.current;
    const x = Math.min(start.x, pointer.x);
    const y = Math.min(start.y, pointer.y);
    const w = Math.abs(pointer.x - start.x);
    const h = Math.abs(pointer.y - start.y);

    // Remove previous preview
    if (previewObjectRef.current) {
      canvas.remove(previewObjectRef.current);
      previewObjectRef.current = null;
    }

    const previewStyle = {
      selectable: false,
      evented: false,
      objectCaching: false,
      opacity: 0.5,
      strokeDashArray: [6, 4],
    };

    let preview: fabric.Object | null = null;
    switch (tool) {
      case 'rectangle':
        preview = new fabric.Rect({
          ...previewStyle,
          left: x,
          top: y,
          width: Math.max(1, w),
          height: Math.max(1, h),
          fill: '#3b82f6',
          stroke: '#1d4ed8',
          strokeWidth: 2,
        });
        break;
      case 'circle':
        preview = new fabric.Circle({
          ...previewStyle,
          left: start.x,
          top: start.y,
          radius: Math.max(1, Math.max(w, h) / 2),
          fill: '#10b981',
          stroke: '#065f46',
          strokeWidth: 2,
        });
        break;
      case 'line':
        preview = new fabric.Path(`M 0 0 L ${pointer.x - start.x} ${pointer.y - start.y}`, {
          ...previewStyle,
          left: start.x,
          top: start.y,
          stroke: '#000000',
          strokeWidth: 2,
          fill: '',
          originX: 'left',
          originY: 'top',
        });
        break;
      case 'arrow': {
        const dx = pointer.x - start.x;
        const dy2 = pointer.y - start.y;
        const angle = Math.atan2(dy2, dx);
        const arrowLen = 14;
        const ax1 = dx - arrowLen * Math.cos(angle - Math.PI / 6);
        const ay1 = dy2 - arrowLen * Math.sin(angle - Math.PI / 6);
        const ax2 = dx - arrowLen * Math.cos(angle + Math.PI / 6);
        const ay2 = dy2 - arrowLen * Math.sin(angle + Math.PI / 6);
        preview = new fabric.Path(
          `M 0 0 L ${dx} ${dy2} M ${ax1} ${ay1} L ${dx} ${dy2} L ${ax2} ${ay2}`,
          {
            ...previewStyle,
            left: start.x,
            top: start.y,
            stroke: '#000000',
            strokeWidth: 2,
            fill: '',
            originX: 'left',
            originY: 'top',
          }
        );
        break;
      }
      case 'text':
        preview = new fabric.Rect({
          ...previewStyle,
          left: start.x,
          top: start.y,
          width: Math.max(1, w),
          height: Math.max(1, h || 30),
          fill: 'transparent',
          stroke: '#6366f1',
          strokeWidth: 2,
        });
        break;
      case 'sticky_note':
        preview = new fabric.Rect({
          ...previewStyle,
          left: start.x,
          top: start.y,
          width: 200,
          height: 200,
          fill: '#fef08a',
          stroke: '#ca8a04',
          strokeWidth: 2,
        });
        break;
    }

    if (preview) {
      canvas.add(preview);
      previewObjectRef.current = preview;
      canvas.renderAll();
    }
  }, []);

  const handleMouseUp = useCallback((e: fabric.TPointerEventInfo) => {
    if (isPanningRef.current) {
      isPanningRef.current = false;
      panStartRef.current = null;
      return;
    }

    if (!isDrawingRef.current || !drawStartRef.current) return;

    // Remove the rubber-band preview before committing the real element
    const canvas = fabricCanvasRef.current;
    if (canvas && previewObjectRef.current) {
      canvas.remove(previewObjectRef.current);
      previewObjectRef.current = null;
    }

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
          properties: { x, y, width: w, height: h, fill: '#3b82f6', scaleX: 1, scaleY: 1 },
          zIndex: 0,
        };
        break;

      case 'circle':
        elementData = {
          boardId: boardIdRef.current,
          type: ElementType.CIRCLE,
          properties: { x: start.x, y: start.y, radius: Math.max(w, h) / 2, fill: '#10b981', scaleX: 1, scaleY: 1 },
          zIndex: 0,
        };
        break;

      case 'text':
        elementData = {
          boardId: boardIdRef.current,
          type: ElementType.TEXT,
          properties: { x: start.x, y: start.y, text: 'Double click to edit', fontSize: 20, color: '#000000', scaleX: 1, scaleY: 1 },
          zIndex: 0,
        };
        break;

      case 'sticky_note':
        elementData = {
          boardId: boardIdRef.current,
          type: ElementType.STICKY_NOTE,
          properties: { x: start.x, y: start.y, width: 200, height: 200, text: 'New note', color: '#fef08a', scaleX: 1, scaleY: 1 },
          zIndex: 0,
        };
        break;

      case 'line':
        elementData = {
          boardId: boardIdRef.current,
          type: ElementType.LINE,
          properties: { x: start.x, y: start.y, x2: pointer.x, y2: pointer.y, stroke: '#000000', strokeWidth: 2, scaleX: 1, scaleY: 1 },
          zIndex: 0,
        };
        break;

      case 'arrow':
        elementData = {
          boardId: boardIdRef.current,
          type: ElementType.ARROW,
          properties: { x: start.x, y: start.y, x2: pointer.x, y2: pointer.y, stroke: '#000000', strokeWidth: 2, scaleX: 1, scaleY: 1 },
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
    // Clear pendingSelectIdRef if the server doesn't echo the client UUID within 5 s.
    // Prevents permanent suppression of future text/sticky creation on ID-overriding backends.
    const capturedId = optimisticId;
    setTimeout(() => {
      if (pendingSelectIdRef.current === capturedId) {
        pendingSelectIdRef.current = null;
      }
    }, 5000);
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

      // Standalone objects: left/top are absolute canvas coords (originX: 'left').
      // Grouped objects: left/top are group-relative — apply the group's transform.
      // Use transformPoint (not getBoundingRect) so stroke does not inflate the stored position.
      const isInGroup = (child as any).group?.type === 'activeSelection';
      let absLeft: number, absTop: number;
      if (isInGroup) {
        const groupMatrix = (child as any).group.calcTransformMatrix();
        const pt = new fabric.Point(child.left ?? 0, child.top ?? 0).transform(groupMatrix);
        absLeft = pt.x;
        absTop = pt.y;
      } else {
        absLeft = child.left ?? 0;
        absTop = child.top ?? 0;
      }

      // For LINE/ARROW the endpoint (x2/y2) is an absolute canvas coordinate.
      // Shift it by the same delta as the origin so geometry is preserved after a move.
      const updates: Element['properties'] = {
        ...buildTransformUpdates(element.properties, {
          absLeft,
          absTop,
          width: child.width ?? (element.properties.width ?? 0),
          height: child.height ?? (element.properties.height ?? 0),
          scaleX: child.scaleX,
          scaleY: child.scaleY,
        }),
      };

      onElementUpdateRef.current(elementId, { properties: updates });
    };

    if ((obj as any).type === 'activeSelection') {
      (obj as fabric.ActiveSelection).getObjects().forEach(emitUpdate);
    } else {
      emitUpdate(obj);
    }
    onGestureEndRef.current?.();
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
      safeRenderCanvas(canvas, 'resize');
    };
    window.addEventListener('resize', handleResize);

    const buildTransformProperties = (child: fabric.Object) => {
      const elementId = (child as any).data?.elementId as string | undefined;
      if (!elementId) return null;
      const element = elementsRef.current.find(el => el.id === elementId);
      if (!element) return null;

      // Standalone objects: left/top are absolute canvas coords (originX: 'left').
      // Grouped objects: left/top are group-relative — apply the group's transform.
      const isInGroup = (child as any).group?.type === 'activeSelection';
      let absLeft: number;
      let absTop: number;
      if (isInGroup) {
        const groupMatrix = (child as any).group.calcTransformMatrix();
        const pt = new fabric.Point(child.left ?? 0, child.top ?? 0).transform(groupMatrix);
        absLeft = pt.x;
        absTop = pt.y;
      } else {
        absLeft = child.left ?? 0;
        absTop = child.top ?? 0;
      }

      const updates: Element['properties'] = buildTransformUpdates(element.properties, {
        absLeft,
        absTop,
        width: child.width ?? (element.properties.width ?? 0),
        height: child.height ?? (element.properties.height ?? 0),
        scaleX: child.scaleX,
        scaleY: child.scaleY,
      });

      return { elementId, updates };
    };

    // Throttled live-transform emitter (fires while dragging/scaling, not just on mouse-up)
    const emitTransform = throttleFn((e: { target: fabric.Object }) => {
      const obj = e.target;
      if (!obj) return;

      const emitOne = (child: fabric.Object) => {
        const transform = buildTransformProperties(child);
        if (!transform) return;
        // Use drag-only callback — broadcasts the current geometry for collaboration but does NOT record history
        onElementDragUpdateRef.current?.(transform.elementId, {
          properties: transform.updates,
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

    // Selection tracking — report null for multi-select so the ColorPicker hides
    const handleSelectionCreated = () => {
      const all = canvas.getActiveObjects();
      if (all.length !== 1) { onSelectionChangeRef.current?.(null); return; }
      const elementId = (all[0] as any)?.data?.elementId as string | undefined;
      onSelectionChangeRef.current?.(elementId ?? null);
    };
    const handleSelectionUpdated = () => {
      const all = canvas.getActiveObjects();
      if (all.length !== 1) { onSelectionChangeRef.current?.(null); return; }
      const elementId = (all[0] as any)?.data?.elementId as string | undefined;
      onSelectionChangeRef.current?.(elementId ?? null);
    };
    const handleSelectionCleared = () => {
      onSelectionChangeRef.current?.(null);
    };

    // Keyboard handlers
    const handleKeyDown = (e: KeyboardEvent) => {
      // Space → grab/pan cursor; prevent Fabric from selecting/moving objects on click
      if (e.code === 'Space' && !e.repeat) {
        spaceHeldRef.current = true;
        canvas.selection = false;
        canvas.forEachObject(o => {
          // Only toggle real elements — leave ephemeral objects (bgRect, standaloneText
          // from sticky-note edit mode) in their explicit non-selectable state.
           
          if ((o as any).data?.elementId) o.selectable = false;
        });
        canvas.defaultCursor = 'grab';
        safeRenderCanvas(canvas, 'space-down');
        return;
      }

      // ESC → deselect
      if (e.key === 'Escape') {
        canvas.discardActiveObject();
        safeRenderCanvas(canvas, 'escape-clear-selection');
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
        safeRenderCanvas(canvas, 'keyboard-delete');
        toast.success(ids.length > 1 ? `${ids.length} elements deleted` : 'Element deleted');
        return;
      }

      // Ctrl+C → copy (supports multi-select)
      if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        const ids = canvas.getActiveObjects()
          .map(o => (o as any).data?.elementId as string | undefined)
          .filter(Boolean) as string[];
        if (ids.length > 0) clipboardRef.current = { elementIds: ids };
        return;
      }

      // Ctrl+V → paste with +20 offset (supports multi-select)
      if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
        if (!clipboardRef.current) return;
        clipboardRef.current.elementIds.forEach(elementId => {
          const element = elementsRef.current.find(el => el.id === elementId);
          if (!element) return;
          const pastedProps = {
            ...element.properties,
            x: (element.properties.x ?? 0) + 20,
            y: (element.properties.y ?? 0) + 20,
            // LINE/ARROW store the endpoint as absolute coords — shift by the same offset.
            ...(element.properties.x2 !== undefined && {
              x2: element.properties.x2 + 20,
              y2: (element.properties.y2 ?? 0) + 20,
            }),
          };
          onElementCreateRef.current({
            boardId: boardIdRef.current,
            type: element.type,
            properties: pastedProps,
            zIndex: element.zIndex,
          });
        });
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceHeldRef.current = false;
        canvas.selection = selectedToolRef.current === 'select';
        canvas.forEachObject(o => {
           
          if ((o as any).data?.elementId) o.selectable = true;
        });
        canvas.defaultCursor = selectedToolRef.current === 'select' ? 'default' : 'crosshair';
        safeRenderCanvas(canvas, 'space-up');
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
          onGestureEndRef.current?.();
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
      safeRenderCanvas(canvas, 'path-created');
      const bounds = path.getBoundingRect();
      const penOptimisticId = crypto.randomUUID();
      pendingSelectIdRef.current = penOptimisticId;
      setTimeout(() => {
        if (pendingSelectIdRef.current === penOptimisticId) {
          pendingSelectIdRef.current = null;
        }
      }, 5000);
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

    let scalingInProgress = false;
    const handleObjectMoving = (e: { target: fabric.Object }) => {
      if (scalingInProgress) return;
      emitTransform(e);
    };
    const handleObjectScaling = (e: { target: fabric.Object }) => {
      scalingInProgress = true;
      emitTransform(e);
    };
    const handleObjectModifiedWithReset = (e: fabric.ModifiedEvent) => {
      scalingInProgress = false;
      handleObjectModified(e);
    };

    canvas.on('mouse:down', handleMouseDown);
    canvas.on('mouse:move', handleMouseMove);
    canvas.on('mouse:up', handleMouseUp);
    canvas.on('mouse:dblclick', handleDblClick);
    canvas.on('object:modified', handleObjectModifiedWithReset);
    canvas.on('object:moving', handleObjectMoving as any);
    canvas.on('object:scaling', handleObjectScaling as any);
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
      canvas.off('object:modified', handleObjectModifiedWithReset);
      canvas.off('object:moving', handleObjectMoving as any);
      canvas.off('object:scaling', handleObjectScaling as any);
      canvas.off('mouse:wheel', handleWheel);
      canvas.off('selection:created', handleSelectionCreated);
      canvas.off('selection:updated', handleSelectionUpdated);
      canvas.off('selection:cleared', handleSelectionCleared);
      canvas.off('path:created', handlePathCreated);
      canvas.dispose();
    };
  }, [
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleObjectModified,
    enterStickyEditMode,
    safeRenderCanvas,
  ]);

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
    // Restore selectable state — but don't override Space-pan mode, which manages it separately
    if (!spaceHeldRef.current) {
      canvas.forEachObject(obj => { obj.selectable = true; });
    }
    canvas.defaultCursor = isSelect ? 'default' : 'crosshair';
    safeRenderCanvas(canvas, 'tool-sync');
  }, [safeRenderCanvas, selectedTool]);

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
                onGestureEndRef.current?.();
              });
            } else if (el.type === ElementType.STICKY_NOTE) {
              // Defer one frame so the object is fully settled on the canvas
              requestAnimationFrame(() => enterStickyEditMode(obj as fabric.Group, el.id));
            }
          }
        }
      } else {
        // Prevent Fabric from drawing stale/invalid zero-size cache canvases.
        existing.set('objectCaching', false);
        // Apply style + position updates without recreating the object
        const p = el.properties;

        // For sticky notes (Group), the background color lives on the inner Rect,
        // not on the Group itself. Both `fill` (from ColorPicker) and `color`
        // (original property name) must be forwarded to that child Rect.
        if (existing.type === 'group') {
          const group = existing as fabric.Group;
          const innerRect = group.getObjects().find(o => o.type === 'rect') as fabric.Rect | undefined;
          const innerText = group.getObjects().find(o => o.type === 'textbox') as fabric.Textbox | undefined;

          // 1. Style on inner rect first
          const newFill = p.fill ?? p.color;
          if (innerRect && newFill !== undefined) {
            innerRect.set('fill', newFill);
            (innerRect as any).dirty = true;
          }
          if (p.stroke !== undefined) innerRect?.set('stroke', p.stroke);
          if (p.strokeWidth !== undefined) innerRect?.set('strokeWidth', p.strokeWidth);
          (existing as any).dirty = true;

          // 2. Text content — syncs remote edits and prevents the local stale-text
          //    race condition where the Group is re-added before the WS echo arrives.
          if (innerText !== undefined && p.text !== undefined) {
            innerText.set('text', String(p.text));
            innerText.initDimensions();
            (innerText as any).dirty = true;
          }

          // 3. Position
          if (p.x !== undefined) existing.set('left', p.x);
          if (p.y !== undefined) existing.set('top', p.y);
          // 4. Scale — must be applied BEFORE dimensions so the division below uses the new scale
          // Always apply scale, defaulting to 1 when absent (e.g. undo restores pre-resize state
          // that was created before scaleX/scaleY were persisted — missing = reset to default 1).
          existing.set('scaleX', normalizeScale(p.scaleX ?? 1, 1));
          existing.set('scaleY', normalizeScale(p.scaleY ?? 1, 1));
          // 5. Base dimensions: resize both the inner Rect and the Group wrapper
          const nextDims = resolveSyncBaseDimensions({
            width: p.width,
            height: p.height,
            currentWidth: existing.width,
            currentHeight: existing.height,
          });
          if (innerRect) {
            innerRect.set({ width: nextDims.width, height: nextDims.height });
          }
          if (innerText) {
            innerText.set({
              width: Math.max(20, nextDims.width - 20),
              splitByGrapheme: true,
            });
            innerText.initDimensions();
          }
          (existing as any).set('width', nextDims.width);
          (existing as any).set('height', nextDims.height);
          // 6. Always last
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
          // Always apply scale, defaulting to 1 when absent (undo may restore a state that
          // predates explicit scaleX/scaleY persistence — missing = reset to default 1).
          existing.set('scaleX', normalizeScale(p.scaleX ?? 1, 1));
          existing.set('scaleY', normalizeScale(p.scaleY ?? 1, 1));

          // Keep line/arrow path geometry aligned with endpoint updates.
          if (existing.type === 'path' && (el.type === ElementType.LINE || el.type === ElementType.ARROW)) {
            try {
              let nextPath: fabric.Path | null = null;

              if (typeof p.pathData === 'string') {
                 
                const parsedPath = JSON.parse(p.pathData) as any;
                nextPath = new fabric.Path(parsedPath as string);
              } else {
                const x = p.x ?? 0;
                const y = p.y ?? 0;
                const x2 = p.x2 ?? (x + 100);
                const y2 = p.y2 ?? y;
                const dx = x2 - x;
                const dy = y2 - y;

                if (el.type === ElementType.ARROW) {
                  const angle = Math.atan2(dy, dx);
                  const arrowLen = 14;
                  const ax1 = dx - arrowLen * Math.cos(angle - Math.PI / 6);
                  const ay1 = dy - arrowLen * Math.sin(angle - Math.PI / 6);
                  const ax2 = dx - arrowLen * Math.cos(angle + Math.PI / 6);
                  const ay2 = dy - arrowLen * Math.sin(angle + Math.PI / 6);
                  nextPath = new fabric.Path(
                    `M 0 0 L ${dx} ${dy} M ${ax1} ${ay1} L ${dx} ${dy} L ${ax2} ${ay2}`
                  );
                } else {
                  nextPath = new fabric.Path(`M 0 0 L ${dx} ${dy}`);
                }
              }

              if (nextPath) {
                (existing as fabric.Path).set({
                  path: nextPath.path,
                  width: nextPath.width,
                  height: nextPath.height,
                  pathOffset: nextPath.pathOffset,
                });
              }
            } catch {
              // Ignore malformed path data and keep the previous geometry.
            }
          }

          // 4. Base dimensions for rects (stored as raw, unscaled dimensions)
          if (existing.type === 'rect') {
            const nextDims = resolveSyncBaseDimensions({
              width: p.width,
              height: p.height,
              currentWidth: (existing as any).width,
              currentHeight: (existing as any).height,
            });
            (existing as any).set('width', nextDims.width);
            (existing as any).set('height', nextDims.height);
          }
          // 5. Always last
          existing.setCoords();
        }
      }
    });

    // Reorder Fabric objects to match zIndex. canvas.moveTo(obj, index) places the
    // object at the given position in the internal objects array (lower = rendered first).
    // Only elements with a data.elementId are considered; ephemeral objects (sticky
    // edit bgRect / standaloneText) sit outside this set and are left where they are.
    const sorted = [...elements].sort((a, b) => a.zIndex - b.zIndex);
    sorted.forEach((el, targetIndex) => {
      const obj = canvas.getObjects().find(o => (o as any).data?.elementId === el.id);
      if (obj) canvas.moveObjectTo(obj, targetIndex);
    });

    safeRenderCanvas(canvas, 'elements-sync');
  }, [elements, createFabricObject, enterStickyEditMode, safeRenderCanvas]);

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
      safeRenderCanvas(canvas, 'imperative-delete-selected');
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
      // Do NOT clear editingStickyIdRef here — the once('editing:exited') handler in
      // enterStickyEditMode owns that transition and clears it after removing phantom objects.
      // Clearing it here races with the elements sync effect and can cause the Group to be
      // re-added while bgRect/standaloneText are still present on the canvas.
      canvas.discardActiveObject();
      safeRenderCanvas(canvas, 'imperative-clear-selection');
    },
  }), [safeRenderCanvas]);

  return (
    <div className="relative w-full h-full">
      <canvas ref={canvasRef} />
    </div>
  );
});

export default Canvas;
