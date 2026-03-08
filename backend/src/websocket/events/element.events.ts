import { Socket } from 'socket.io';
import redis from '../../config/redis';
import prisma from '../../config/database';
import { v4 as uuidv4 } from 'uuid';
import { ElementType } from '@prisma/client';

interface CreateElementData {
  boardId: string;
  userId: string;
  type: string;
  properties: any;
}

interface UpdateElementData {
  boardId: string;
  elementId: string;
  userId: string;
  properties: any;
  /** When true this is an intermediate live-drag update — do NOT save a snapshot */
  live?: boolean;
}

interface DeleteElementData {
  boardId: string;
  elementId: string;
  userId: string;
}

interface UndoRedoData {
  boardId: string;
  userId: string;
}

export class ElementEvents {
  // ─── Snapshot helpers ────────────────────────────────────────────────────────

  private async saveSnapshot(boardId: string): Promise<void> {
    const elements = await prisma.element.findMany({
      where: { boardId },
      orderBy: { zIndex: 'asc' },
    });

    const snapshot = elements.map(el => ({
      id: el.id,
      boardId: el.boardId,
      type: el.type,
      properties: el.properties,
      zIndex: el.zIndex,
      createdBy: el.createdBy,
    }));

    await redis.lpush(`snapshots:${boardId}`, JSON.stringify(snapshot));
    await redis.ltrim(`snapshots:${boardId}`, 0, 49);
    // Any new mutation clears the redo stack
    await redis.del(`redo:${boardId}`);
  }

  private async restoreSnapshot(
    boardId: string,
    snapshot: any[]
  ): Promise<void> {
    await prisma.element.deleteMany({ where: { boardId } });
    if (snapshot.length > 0) {
      await prisma.element.createMany({
        data: snapshot.map(el => ({
          id: el.id,
          boardId: el.boardId,
          type: el.type as ElementType,
          properties: el.properties,
          zIndex: el.zIndex ?? 0,
          createdBy: el.createdBy,
        })),
      });
    }
  }

  // ─── CRUD handlers ───────────────────────────────────────────────────────────

  async handleCreateElement(socket: Socket, io: any, data: CreateElementData) {
    const { boardId, userId, type, properties } = data;

    try {
      const hasAccess = await this.checkBoardAccess(boardId, userId, 'EDITOR');
      if (!hasAccess) {
        socket.emit('error', { message: 'Permission denied' });
        return;
      }

      if (!Object.values(ElementType).includes(type as ElementType)) {
        socket.emit('error', { message: 'Invalid element type' });
        return;
      }

      // Save board state before mutation; clears redo stack
      await this.saveSnapshot(boardId);

      const elementId = uuidv4();

      const element = await prisma.element.create({
        data: {
          id: elementId,
          boardId,
          type: type as ElementType,
          properties,
          zIndex: 0,
          createdBy: userId,
        },
      });

      // Add to Redis Stream (event sourcing)
      await redis.xadd(
        `events:board:${boardId}`,
        '*',
        'action', 'create',
        'elementId', elementId,
        'userId', userId,
        'type', type,
        'data', JSON.stringify(properties),
        'timestamp', Date.now().toString()
      );

      // Publish to Redis Pub/Sub
      await redis.publish(
        `board:${boardId}:elements`,
        JSON.stringify({ action: 'create', element })
      );

      io.to(`board:${boardId}`).emit('element:created', element);

      console.log(`✅ Element ${elementId} created on board ${boardId}`);
    } catch (error) {
      console.error('Error creating element:', error);
      socket.emit('error', { message: 'Failed to create element' });
    }
  }

  async handleUpdateElement(socket: Socket, io: any, data: UpdateElementData) {
    const { boardId, elementId, userId, properties, live } = data;

    try {
      const hasAccess = await this.checkBoardAccess(boardId, userId, 'EDITOR');
      if (!hasAccess) {
        socket.emit('error', { message: 'Permission denied' });
        return;
      }

      const currentElement = await prisma.element.findUnique({
        where: { id: elementId },
      });

      if (!currentElement) {
        socket.emit('error', { message: 'Element not found' });
        return;
      }

      // Only save a snapshot at gesture-end (commit) updates, not on every live drag tick
      if (!live) {
        await this.saveSnapshot(boardId);
      }

      const updatedElement = await prisma.element.update({
        where: { id: elementId },
        data: {
          properties: {
            ...(currentElement.properties as Record<string, unknown>),
            ...properties,
          },
        },
      });

      // Add to history (Redis Sorted Set)
      await redis.zadd(
        `history:${boardId}:${userId}`,
        Date.now(),
        JSON.stringify({
          action: 'update',
          elementId,
          before: currentElement.properties,
          after: updatedElement.properties,
        })
      );
      await redis.zremrangebyrank(`history:${boardId}:${userId}`, 0, -51);

      await redis.xadd(
        `events:board:${boardId}`,
        '*',
        'action', 'update',
        'elementId', elementId,
        'userId', userId,
        'data', JSON.stringify(properties),
        'timestamp', Date.now().toString()
      );

      io.to(`board:${boardId}`).emit('element:updated', {
        id: elementId,
        properties: updatedElement.properties,
      });

      console.log(`✅ Element ${elementId} updated`);
    } catch (error) {
      console.error('Error updating element:', error);
      socket.emit('error', { message: 'Failed to update element' });
    }
  }

  async handleDeleteElement(socket: Socket, io: any, data: DeleteElementData) {
    const { boardId, elementId, userId } = data;

    try {
      const hasAccess = await this.checkBoardAccess(boardId, userId, 'EDITOR');
      if (!hasAccess) {
        socket.emit('error', { message: 'Permission denied' });
        return;
      }

      const element = await prisma.element.findUnique({
        where: { id: elementId },
      });

      if (!element) {
        socket.emit('error', { message: 'Element not found' });
        return;
      }

      // Save board state before mutation; clears redo stack
      await this.saveSnapshot(boardId);

      await prisma.element.delete({ where: { id: elementId } });

      await redis.zadd(
        `history:${boardId}:${userId}`,
        Date.now(),
        JSON.stringify({ action: 'delete', elementId, element })
      );

      await redis.xadd(
        `events:board:${boardId}`,
        '*',
        'action', 'delete',
        'elementId', elementId,
        'userId', userId,
        'timestamp', Date.now().toString()
      );

      io.to(`board:${boardId}`).emit('element:deleted', { id: elementId });

      console.log(`✅ Element ${elementId} deleted`);
    } catch (error) {
      console.error('Error deleting element:', error);
      socket.emit('error', { message: 'Failed to delete element' });
    }
  }

  // ─── Undo / Redo ─────────────────────────────────────────────────────────────

  async handleUndo(socket: Socket, io: any, data: UndoRedoData) {
    const { boardId, userId } = data;

    try {
      const hasAccess = await this.checkBoardAccess(boardId, userId, 'EDITOR');
      if (!hasAccess) {
        socket.emit('error', { message: 'Permission denied' });
        return;
      }

      const snapshotStr = await redis.lindex(`snapshots:${boardId}`, 0);
      if (!snapshotStr) {
        // Nothing to undo — emit empty snapshot so frontend stays in sync
        return;
      }

      // Save current state to redo stack before restoring
      const currentElements = await prisma.element.findMany({
        where: { boardId },
        orderBy: { zIndex: 'asc' },
      });
      const currentSnapshot = currentElements.map(el => ({
        id: el.id,
        boardId: el.boardId,
        type: el.type,
        properties: el.properties,
        zIndex: el.zIndex,
        createdBy: el.createdBy,
      }));
      await redis.lpush(`redo:${boardId}`, JSON.stringify(currentSnapshot));
      await redis.ltrim(`redo:${boardId}`, 0, 49);

      // Pop undo snapshot
      await redis.lpop(`snapshots:${boardId}`);

      const snapshot: any[] = JSON.parse(snapshotStr);
      await this.restoreSnapshot(boardId, snapshot);

      io.to(`board:${boardId}`).emit('element:snapshot', snapshot);

      console.log(`↩️  Undo on board ${boardId}: restored ${snapshot.length} elements`);
    } catch (error) {
      console.error('Error handling undo:', error);
      socket.emit('error', { message: 'Failed to undo' });
    }
  }

  async handleRedo(socket: Socket, io: any, data: UndoRedoData) {
    const { boardId, userId } = data;

    try {
      const hasAccess = await this.checkBoardAccess(boardId, userId, 'EDITOR');
      if (!hasAccess) {
        socket.emit('error', { message: 'Permission denied' });
        return;
      }

      const redoStr = await redis.lindex(`redo:${boardId}`, 0);
      if (!redoStr) {
        return;
      }

      // Save current state back to undo stack before applying redo
      const currentElements = await prisma.element.findMany({
        where: { boardId },
        orderBy: { zIndex: 'asc' },
      });
      const currentSnapshot = currentElements.map(el => ({
        id: el.id,
        boardId: el.boardId,
        type: el.type,
        properties: el.properties,
        zIndex: el.zIndex,
        createdBy: el.createdBy,
      }));
      await redis.lpush(`snapshots:${boardId}`, JSON.stringify(currentSnapshot));
      await redis.ltrim(`snapshots:${boardId}`, 0, 49);

      // Pop redo snapshot
      await redis.lpop(`redo:${boardId}`);

      const snapshot: any[] = JSON.parse(redoStr);
      await this.restoreSnapshot(boardId, snapshot);

      io.to(`board:${boardId}`).emit('element:snapshot', snapshot);

      console.log(`↪️  Redo on board ${boardId}: restored ${snapshot.length} elements`);
    } catch (error) {
      console.error('Error handling redo:', error);
      socket.emit('error', { message: 'Failed to redo' });
    }
  }

  // ─── Clear board ─────────────────────────────────────────────────────────────

  async handleClearBoard(socket: Socket, io: any, data: { boardId: string; userId: string }) {
    const { boardId, userId } = data;
    try {
      const hasAccess = await this.checkBoardAccess(boardId, userId, 'EDITOR');
      if (!hasAccess) {
        socket.emit('error', { message: 'Permission denied' });
        return;
      }

      await this.saveSnapshot(boardId);
      await prisma.element.deleteMany({ where: { boardId } });

      io.to(`board:${boardId}`).emit('board:cleared');
      console.log(`🗑️  Board ${boardId} cleared by ${userId}`);
    } catch (error) {
      console.error('Error clearing board:', error);
      socket.emit('error', { message: 'Failed to clear board' });
    }
  }

  // ─── Access control ──────────────────────────────────────────────────────────

  private async checkBoardAccess(
    boardId: string,
    userId: string,
    _requiredRole: string
  ): Promise<boolean> {
    const board = await prisma.board.findFirst({
      where: {
        id: boardId,
        OR: [
          { ownerId: userId },
          {
            collaborators: {
              some: {
                userId,
                role: { in: ['EDITOR', 'ADMIN'] },
              },
            },
          },
        ],
      },
    });
    return !!board;
  }
}
