'use client';

import { useEffect, useRef, useState } from 'react';
import * as fabric from 'fabric';
import { Element, ElementType } from '@/types/element';

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
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(null);

  // Initialize Fabric.js canvas
  useEffect(() => {
    if (!canvasRef.current) return;

    const canvas = new fabric.Canvas(canvasRef.current, {
      width: window.innerWidth,
      height: window.innerHeight,
      backgroundColor: '#ffffff',
    });

    fabricCanvasRef.current = canvas;

    // Handle window resize
    const handleResize = () => {
      canvas.setDimensions({
        width: window.innerWidth,
        height: window.innerHeight,
      });
      canvas.renderAll();
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      canvas.dispose();
    };
  }, []);

  // Load existing elements
  useEffect(() => {
    if (!fabricCanvasRef.current) return;

    const canvas = fabricCanvasRef.current;
    canvas.clear();

    elements.forEach((element) => {
      const fabricObject = createFabricObject(element);
      if (fabricObject) {
        canvas.add(fabricObject);
      }
    });

    canvas.renderAll();
  }, [elements]);

  // Handle tool changes and drawing
  useEffect(() => {
    if (!fabricCanvasRef.current) return;

    const canvas = fabricCanvasRef.current;

    if (selectedTool === 'select') {
      canvas.isDrawingMode = false;
      canvas.selection = true;
      canvas.forEachObject((obj) => {
        obj.selectable = true;
      });
    } else {
      canvas.isDrawingMode = false;
      canvas.selection = false;
      canvas.forEachObject((obj) => {
        obj.selectable = false;
      });
    }
  }, [selectedTool]);

  // Create Fabric object from element data
  const createFabricObject = (element: Element): fabric.Object | null => {
    const { type, properties } = element;

    switch (type) {
      case ElementType.RECTANGLE:
        return new fabric.Rect({
          left: properties.x,
          top: properties.y,
          width: properties.width || 100,
          height: properties.height || 100,
          fill: properties.fill || '#3b82f6',
          stroke: properties.stroke,
          strokeWidth: properties.strokeWidth || 0,
        });

      case ElementType.CIRCLE:
        return new fabric.Circle({
          left: properties.x,
          top: properties.y,
          radius: properties.radius || 50,
          fill: properties.fill || '#10b981',
          stroke: properties.stroke,
          strokeWidth: properties.strokeWidth || 0,
        });

      case ElementType.TEXT:
        return new fabric.Text(properties.text || 'Text', {
          left: properties.x,
          top: properties.y,
          fontSize: properties.fontSize || 20,
          fill: properties.color || '#000000',
        });

      case ElementType.STICKY_NOTE:
        const group = new fabric.Group(
          [
            new fabric.Rect({
              width: properties.width || 200,
              height: properties.height || 200,
              fill: properties.color || '#fef08a',
              stroke: '#ca8a04',
              strokeWidth: 1,
            }),
            new fabric.Text(properties.text || 'Note', {
              fontSize: 16,
              fill: '#000000',
              width: (properties.width || 200) - 20,
              top: 10,
              left: 10,
            }),
          ],
          {
            left: properties.x,
            top: properties.y,
          }
        );
        return group;

      default:
        return null;
    }
  };

  // Handle mouse down for drawing
  const handleMouseDown = (e: fabric.TPointerEventInfo) => {
    if (selectedTool === 'select') return;

    const pointer = fabricCanvasRef.current?.getScenePoint(e.e);
    if (!pointer) return;

    setIsDrawing(true);
    setDrawStart({ x: pointer.x, y: pointer.y });
  };

  // Handle mouse up for drawing
  const handleMouseUp = (e: fabric.TPointerEventInfo) => {
    if (!isDrawing || !drawStart) return;

    const pointer = fabricCanvasRef.current?.getScenePoint(e.e);
    if (!pointer) return;

    const width = Math.abs(pointer.x - drawStart.x);
    const height = Math.abs(pointer.y - drawStart.y);

    let elementData: Partial<Element> = {
      boardId,
      type: ElementType.RECTANGLE,
      properties: {
        x: Math.min(drawStart.x, pointer.x),
        y: Math.min(drawStart.y, pointer.y),
        width,
        height,
      },
      zIndex: 0,
    };

    switch (selectedTool) {
      case 'rectangle':
        elementData.type = ElementType.RECTANGLE;
        elementData.properties = {
          ...elementData.properties,
          fill: '#3b82f6',
        };
        break;

      case 'circle':
        elementData.type = ElementType.CIRCLE;
        elementData.properties = {
          x: drawStart.x,
          y: drawStart.y,
          radius: Math.max(width, height) / 2,
          fill: '#10b981',
        };
        break;

      case 'text':
        elementData.type = ElementType.TEXT;
        elementData.properties = {
          x: drawStart.x,
          y: drawStart.y,
          text: 'Double click to edit',
          fontSize: 20,
          color: '#000000',
        };
        break;

      case 'sticky_note':
        elementData.type = ElementType.STICKY_NOTE;
        elementData.properties = {
          x: drawStart.x,
          y: drawStart.y,
          width: 200,
          height: 200,
          text: 'New note',
          color: '#fef08a',
        };
        break;
    }

    onElementCreate(elementData);

    setIsDrawing(false);
    setDrawStart(null);
  };

  // Attach event listeners
  useEffect(() => {
    if (!fabricCanvasRef.current) return;

    const canvas = fabricCanvasRef.current;

    canvas.on('mouse:down', handleMouseDown);
    canvas.on('mouse:up', handleMouseUp);

    // Handle object modifications
    canvas.on('object:modified', (e) => {
      if (!e.target) return;

      const obj = e.target;
      const element = elements.find((el) => {
        // Match object to element (you'll need to add IDs to objects)
        return true; // Simplified for now
      });

      if (element) {
        onElementUpdate(element.id, {
          properties: {
            ...element.properties,
            x: obj.left || 0,
            y: obj.top || 0,
            width: obj.width,
            height: obj.height,
          },
        });
      }
    });

    return () => {
      canvas.off('mouse:down');
      canvas.off('mouse:up');
      canvas.off('object:modified');
    };
  }, [selectedTool, elements, isDrawing, drawStart]);

  return (
    <div className="relative w-full h-full">
      <canvas ref={canvasRef} />
    </div>
  );
}