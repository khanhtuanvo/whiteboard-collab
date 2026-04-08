export enum ElementType {
  RECTANGLE = 'RECTANGLE',
  CIRCLE = 'CIRCLE',
  LINE = 'LINE',
  TEXT = 'TEXT',
  STICKY_NOTE = 'STICKY_NOTE',
  IMAGE = 'IMAGE',
  ARROW = 'ARROW',
}

export interface Element {
  id: string;
  boardId: string;
  type: ElementType;
  properties: {
    x: number;
    y: number;
    width?: number;
    height?: number;
    radius?: number;
    text?: string;
    color?: string;
    fill?: string;
    stroke?: string;
    strokeWidth?: number;
    fontSize?: number;
    // Line / Arrow endpoints
    x2?: number;
    y2?: number;
    // Transform scale
    scaleX?: number;
    scaleY?: number;
    // Freehand pen path
    pathData?: string;
    [key: string]: unknown;
  };
  zIndex: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Converts a raw API/WebSocket JSON response into a typed Element with proper Date instances. */
export function deserializeElement(raw: unknown): Element {
  const r = raw as Record<string, unknown>;
  return {
    ...(r as unknown as Element),
    createdAt: new Date(r.createdAt as string),
    updatedAt: new Date(r.updatedAt as string),
  };
}