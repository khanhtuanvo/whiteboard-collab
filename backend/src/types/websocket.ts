import { ElementType } from '@prisma/client';

/**
 * Snapshot element stored in Redis for undo/redo functionality
 */
export type SnapshotElement = {
  id: string;
  type: ElementType;
  properties: Record<string, unknown>;
  zIndex: number;
  createdBy: string;
};

/**
 * Snapshot array for undo/redo operations
 */
export type Snapshot = SnapshotElement[];