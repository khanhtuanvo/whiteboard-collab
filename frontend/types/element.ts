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
    [key: string]: any;
  };
  zIndex: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}