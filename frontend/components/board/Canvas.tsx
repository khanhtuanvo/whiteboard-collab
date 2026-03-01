'use client';

import { useEffect, useRef, useCallback } from 'react';
import * as fabric from 'fabric';
import { Element, ElementType } from '@/types/element';

const HEADER_HEIGHT = 64;

interface CanvasProps {
  boardId: string;
  elements: Element[];
  onElementCreate: (element: Partial<Element>) => void;
  onElementUpdate: (id: string, updates: Partial<Element>) => void;
  onElementDelete: (id: string) => void;
  selectedTool: 'select' | 'rectangle' | 'circle' | 'text' | 'sticky_note';
}

export default function Canvas({
  boardId,
  elements,
  onElementCreate,
  onElementUpdate,
  onElementDelete,
  selectedTool,
}: CanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fabricCanvasRef = useRef<fabric.Canvas | null>(null);

  // Use refs for drawing state so handlers never go stale
  const isDrawingRef = useRef(false);
  const drawStartRef = useRef<{ x: number; y: number } | null>(null);

  // Keep latest prop values accessible in stable callbacks
  const selectedToolRef = useRef(selectedTool);
  const elementsRef = useRef(elements);
  const onElementCreateRef = useRef(onElementCreate);
  const onElementUpdateRef = useRef(onElementUpdate);

  useEffect(() => { selectedToolRef.current = selectedTool; }, [selectedTool]);
  useEffect(() => { elementsRef.current = elements; }, [elements]);
  useEffect(() => { onElementCreateRef.current = onElementCreate; }, [onElementCreate]);
  useEffect(() => { onElementUpdateRef.current = onElementUpdate; }, [onElementUpdate]);

  // ─── Create a Fabric object from element data ───────────────────────────────
  const createFabricObject = useCallback((element: Element): fabric.Object | null => {
    const { type, properties } = element;

    const base = {
      // Store element ID on the fabric object for later lookup
      data: { elementId: element.id },
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
              fontSize: 16,
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

  // ─── Stable mouse handlers (read state from refs, never stale) ──────────────
  const handleMouseDown = useCallback((e: fabric.TPointerEventInfo) => {
    if (selectedToolRef.current === 'select') return;
    const pointer = fabricCanvasRef.current?.getScenePoint(e.e);
    if (!pointer) return;
    isDrawingRef.current = true;
    drawStartRef.current = { x: pointer.x, y: pointer.y };
  }, []);

  const handleMouseUp = useCallback((e: fabric.TPointerEventInfo) => {
    if (!isDrawingRef.current || !drawStartRef.current) return;

    const pointer = fabricCanvasRef.current?.getScenePoint(e.e);
    if (!pointer) return;

    const start = drawStartRef.current;
    const w = Math.abs(pointer.x - start.x);
    const h = Math.abs(pointer.y - start.y);
    const x = Math.min(start.x, pointer.x);
    const y = Math.min(start.y, pointer.y);
    const tool = selectedToolRef.current;

    // Ignore accidental single clicks with no drag
    if (w < 2 && h < 2 && tool !== 'text' && tool !== 'sticky_note') {
      isDrawingRef.current = false;
      drawStartRef.current = null;
      return;
    }

    let elementData: Partial<Element>;

    switch (tool) {
      case 'rectangle':
        elementData = {
          boardId,
          type: ElementType.RECTANGLE,
          properties: { x, y, width: w, height: h, fill: '#3b82f6' },
          zIndex: 0,
        };
        break;

      case 'circle':
        elementData = {
          boardId,
          type: ElementType.CIRCLE,
          properties: { x: start.x, y: start.y, radius: Math.max(w, h) / 2, fill: '#10b981' },
          zIndex: 0,
        };
        break;

      case 'text':
        elementData = {
          boardId,
          type: ElementType.TEXT,
          properties: { x: start.x, y: start.y, text: 'Double click to edit', fontSize: 20, color: '#000000' },
          zIndex: 0,
        };
        break;

      case 'sticky_note':
        elementData = {
          boardId,
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
  }, [boardId]);

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

    // Attach stable handlers once — they read from refs so never go stale
    canvas.on('mouse:down', handleMouseDown);
    canvas.on('mouse:up', handleMouseUp);
    canvas.on('object:modified', handleObjectModified);

    return () => {
      window.removeEventListener('resize', handleResize);
      canvas.off('mouse:down', handleMouseDown);
      canvas.off('mouse:up', handleMouseUp);
      canvas.off('object:modified', handleObjectModified);
      canvas.dispose();
    };
  }, [handleMouseDown, handleMouseUp, handleObjectModified]);

  // ─── Sync tool mode ──────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = fabricCanvasRef.current;
    if (!canvas) return;
    const isSelect = selectedTool === 'select';
    canvas.isDrawingMode = false;
    canvas.selection = isSelect;
    canvas.forEachObject(obj => { obj.selectable = isSelect; });
    canvas.defaultCursor = isSelect ? 'default' : 'crosshair';
    canvas.renderAll();
  }, [selectedTool]);

  // ─── Sync elements: diff instead of full clear+redraw ───────────────────────
  useEffect(() => {
    const canvas = fabricCanvasRef.current;
    if (!canvas) return;

    const existingObjects = canvas.getObjects();

    // Build a map of elementId → fabric object for existing objects
    const existingMap = new Map<string, fabric.Object>();
    existingObjects.forEach(obj => {
      const id = (obj as any).data?.elementId;
      if (id) existingMap.set(id, obj);
    });

    const incomingIds = new Set(elements.map(el => el.id));

    // Remove objects no longer in elements
    existingMap.forEach((obj, id) => {
      if (!incomingIds.has(id)) canvas.remove(obj);
    });

    // Add new elements that don't have a fabric object yet
    elements.forEach(el => {
      if (!existingMap.has(el.id)) {
        const obj = createFabricObject(el);
        if (obj) canvas.add(obj);
      }
    });

    canvas.renderAll();
  }, [elements, createFabricObject]);

  return (
    <div className="relative w-full h-full">
      <canvas ref={canvasRef} />
    </div>
  );
}