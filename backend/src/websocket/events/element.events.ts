import { Socket, Server } from 'socket.io';
import redis from '../../config/redis';
import prisma from '../../config/database';
import logger from '../../config/logger';
import { v4 as uuidv4 } from 'uuid';
import { ElementType, Role, Prisma } from '@prisma/client';
import { z } from 'zod';  
// Strict schema — rejects unknown keys to block prototype-pollution payloads.
// Add fields here as the canvas feature set grows.
const PropertiesSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().optional(),
  height: z.number().optional(),
  fill: z.string().optional(),
  stroke: z.string().optional(),
  strokeWidth: z.number().optional(),
  opacity: z.number().optional(),
  rotation: z.number().optional(),
  scaleX: z.number().optional(),
  scaleY: z.number().optional(),
  offsetX: z.number().optional(),
  offsetY: z.number().optional(),
  text: z.string().optional(),
  fontSize: z.number().optional(),
  fontFamily: z.string().optional(),
  fontStyle: z.string().optional(),
  align: z.string().optional(),
  verticalAlign: z.string().optional(),
  lineHeight: z.number().optional(),
  letterSpacing: z.number().optional(),
  padding: z.number().optional(),
  wrap: z.string().optional(),
  points: z.array(z.number()).optional(),
  tension: z.number().optional(),
  closed: z.boolean().optional(),
  pointerLength: z.number().optional(),
  pointerWidth: z.number().optional(),
  pointerAtBeginning: z.boolean().optional(),
  pointerAtEnding: z.boolean().optional(),
  cornerRadius: z.number().optional(),
  radius: z.number().optional(),
  radiusX: z.number().optional(),
  radiusY: z.number().optional(),
  // M2: only allow https:// or data:image/ URIs
  src: z.string().refine(
    v => v.startsWith('https://') || v.startsWith('data:image/'),
    { message: 'src must be a valid https URL or data:image URI' }
  ).optional(),
  color: z.string().optional(),
  dash: z.array(z.number()).optional(),
  dashEnabled: z.boolean().optional(),
  visible: z.boolean().optional(),
  draggable: z.boolean().optional(),
  x2: z.number().optional(),
  y2: z.number().optional(),
  pathData: z.string().optional(),
}).strict();


type ElementProperties = z.infer<typeof PropertiesSchema>;

interface CreateElementData {
  boardId: string;
  userId: string;
  type: string;
  properties: Prisma.JsonValue;
  id?: string;
}

interface UpdateElementData {
  boardId: string;
  elementId: string;
  userId: string;
  properties: ElementProperties;
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

interface ElementSnapshot {
  id: string;
  boardId: string;
  type: string;
  properties: Prisma.JsonValue;
  zIndex: number;
  createdBy: string;
}


/**
 * Writes an event to a Redis Stream capped at maxLen entries.
 * Uses XADD ... MAXLEN ~ maxLen * ... to avoid unbounded growth.
 * The `as any` cast is required because ioredis v5 typings don't expose the
 * MAXLEN option on xadd — the underlying Redis command accepts it correctly.
 */
async function xaddCapped(
  key: string,
  maxLen: number,
  fields: Record<string, string>
): Promise<void> {
  const args: string[] = ['MAXLEN', '~', String(maxLen), '*'];
  for (const [k, v] of Object.entries(fields)) {
    args.push(k, v);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (redis as any).xadd(key, ...args);
}

export class ElementEvents {
  // ─── Snapshot helpers ────────────────────────────────────────────────────────

  /** Read all current board elements as a serialisable snapshot array. */
  private async readCurrentSnapshot(boardId: string): Promise<ElementSnapshot[]> {
    const elements = await prisma.element.findMany({
      where: { boardId },
      orderBy: { zIndex: 'asc' },
    });
    return elements.map(el => ({
      id: el.id,
      boardId: el.boardId,
      type: el.type,
      properties: el.properties,
      zIndex: el.zIndex,
      createdBy: el.createdBy,
    }));
  }

  /**
   * C1 + C2: Push an already-captured snapshot to the user-namespaced undo stack
   * and clear that user's redo stack. Must be called AFTER a successful DB write
   * and wrapped in its own try/catch by the caller so Redis failures never surface
   * as DB errors.
   */
  private async saveSnapshot(boardId: string, userId: string, snapshot: ElementSnapshot[]): Promise<void> {
    await redis.lpush(`snapshots:${boardId}:${userId}`, JSON.stringify(snapshot));
    await redis.ltrim(`snapshots:${boardId}:${userId}`, 0, 49);
    // Any new mutation clears this user's redo stack
    await redis.del(`redo:${boardId}:${userId}`);
  }

  private async restoreSnapshot(
    boardId: string,
    snapshot: ElementSnapshot[]
  ): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await tx.element.deleteMany({ where: { boardId } });
      if (snapshot.length > 0) {
        await tx.element.createMany({
          data: snapshot.map(el => ({
            id: el.id,
            boardId: el.boardId,
            type: el.type as ElementType,
            properties: (el.properties ?? Prisma.JsonNull) as Prisma.InputJsonValue | Prisma.NullTypes.JsonNull,  // ← cast here
            zIndex: el.zIndex ?? 0,
            createdBy: el.createdBy,
          })),
        });
      }
    });
  }

  // ─── CRUD handlers ───────────────────────────────────────────────────────────

  async handleCreateElement(socket: Socket, io: Server, data: CreateElementData) {
    const { boardId, userId, type, properties } = data;

    try {
      const hasAccess = await this.checkBoardAccess(boardId, userId, Role.EDITOR);
      if (!hasAccess) {
        socket.emit('error', { message: 'Permission denied' });
        return;
      }

      if (!Object.values(ElementType).includes(type as ElementType)) {
        socket.emit('error', { message: 'Invalid element type' });
        return;
      }

      const propertiesResult = PropertiesSchema.safeParse(properties);
      if (!propertiesResult.success) {
        socket.emit('error', { message: 'Invalid properties', details: propertiesResult.error.issues });
        return;
      }

      if (data.id !== undefined) {
        const idResult = z.uuid().safeParse(data.id);
        if (!idResult.success) {
          socket.emit('error', { message: 'Invalid element ID format' });
          return;
        }
      }

      const elementId = data.id ?? uuidv4();

      // C1: Capture pre-mutation state BEFORE the DB write
      const preSnapshot = await this.readCurrentSnapshot(boardId);

      const element = await prisma.$transaction(async (tx) => {
        // Lock the board row so concurrent inserts serialise their MAX(zIndex) reads.
        await tx.$executeRaw`SELECT id FROM boards WHERE id = ${boardId} FOR UPDATE`;
        const maxZ = await tx.element.aggregate({
          where: { boardId },
          _max: { zIndex: true },
        });
        const nextZ = (maxZ._max.zIndex ?? 0) + 1;
        return tx.element.create({
          data: {
            id: elementId,
            boardId,
            type: type as ElementType,
            properties: properties as Prisma.InputJsonValue,
            zIndex: nextZ,
            createdBy: userId,
          },
        });
      });

      // C1: Save snapshot only on DB success; Redis failure is non-fatal
      try {
        await this.saveSnapshot(boardId, userId, preSnapshot);
      } catch (redisErr) {
        logger.warn('Snapshot save failed (non-fatal)', { boardId, error: redisErr });
      }

      // Add to Redis Stream (event sourcing) — capped at 1 000 entries per board
      await xaddCapped(`events:board:${boardId}`, 1000, {
        action: 'create',
        elementId,
        userId,
        type,
        data: JSON.stringify(properties),
        timestamp: Date.now().toString(),
      });

      // Publish to Redis Pub/Sub
      await redis.publish(
        `board:${boardId}:elements`,
        JSON.stringify({ action: 'create', element })
      );

      io.to(`board:${boardId}`).emit('element:created', element);

      logger.info('Element created', { elementId, boardId });
    } catch (error) {
      logger.error('Error creating element', { boardId, error });
      const prismaError = error as { code?: string };
      if (prismaError?.code === 'P2002') {
        socket.emit('error', { message: 'Element ID already exists' });
      } else {
        socket.emit('error', { message: 'Failed to create element' });
      }
    }
  }

  async handleUpdateElement(socket: Socket, io: Server, data: UpdateElementData) {
    const { boardId, elementId, userId, properties, live } = data;

    try {
      const hasAccess = await this.checkBoardAccess(boardId, userId, 'EDITOR');
      if (!hasAccess) {
        socket.emit('error', { message: 'Permission denied' });
        return;
      }

      // H2: Validate BEFORE the live branch so unvalidated properties are never broadcast
      const propertiesResult = PropertiesSchema.safeParse(properties);
      if (!propertiesResult.success) {
        socket.emit('error', { message: 'Invalid properties', details: propertiesResult.error.issues });
        return;
      }

      const currentElement = await prisma.element.findUnique({
        where: { id: elementId },
      });

      if (!currentElement) {
        socket.emit('error', { message: 'Element not found' });
        return;
      }

      // Live drag ticks: broadcast the client's full payload directly — no DB read/merge
      // needed here. The pre-drag DB state is preserved for the snapshot at gesture-end.
      if (live) {
        io.to(`board:${boardId}`).emit('element:updated', {
          id: elementId,
          properties,
        });
        return;
      }

      // C1: Capture pre-mutation state BEFORE the DB write
      const preSnapshot = await this.readCurrentSnapshot(boardId);

      // Gesture-end (commit) update: persist.
      const updatedElement = await prisma.$transaction(async (tx) => {
        const elem = await tx.element.findUnique({ where: { id: elementId } });
        if (!elem) throw new Error('Element not found');
        return tx.element.update({
          where: { id: elementId },
          data: {
            properties: {
              ...(elem.properties as Record<string, unknown>),
              ...properties,
            },
          },
        });
      });

      // C1: Save snapshot only on DB success; Redis failure is non-fatal
      try {
        await this.saveSnapshot(boardId, userId, preSnapshot);
      } catch (redisErr) {
        logger.warn('Snapshot save failed (non-fatal)', { boardId, error: redisErr });
      }

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

      await xaddCapped(`events:board:${boardId}`, 1000, {
        action: 'update',
        elementId,
        userId,
        data: JSON.stringify(properties),
        timestamp: Date.now().toString(),
      });

      io.to(`board:${boardId}`).emit('element:updated', {
        id: elementId,
        properties: updatedElement.properties,
      });

      logger.info('Element updated', { elementId, boardId });
    } catch (error) {
      logger.error('Error updating element', { elementId, boardId, error });
      socket.emit('error', { message: 'Failed to update element' });
    }
  }

  async handleDeleteElement(socket: Socket, io: Server, data: DeleteElementData) {
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

      // C1: Capture pre-mutation state BEFORE the DB write
      const preSnapshot = await this.readCurrentSnapshot(boardId);

      await prisma.element.delete({ where: { id: elementId } });

      // C1: Save snapshot only on DB success; Redis failure is non-fatal
      try {
        await this.saveSnapshot(boardId, userId, preSnapshot);
      } catch (redisErr) {
        logger.warn('Snapshot save failed (non-fatal)', { boardId, error: redisErr });
      }

      // L1: Trim history sorted set to last 50 entries
      await redis.zadd(
        `history:${boardId}:${userId}`,
        Date.now(),
        JSON.stringify({ action: 'delete', elementId, element })
      );
      await redis.zremrangebyrank(`history:${boardId}:${userId}`, 0, -51);

      await xaddCapped(`events:board:${boardId}`, 1000, {
        action: 'delete',
        elementId,
        userId,
        timestamp: Date.now().toString(),
      });

      io.to(`board:${boardId}`).emit('element:deleted', { id: elementId });

      logger.info('Element deleted', { elementId, boardId });
    } catch (error) {
      logger.error('Error deleting element', { elementId, boardId, error });
      socket.emit('error', { message: 'Failed to delete element' });
    }
  }

  // ─── Undo / Redo ─────────────────────────────────────────────────────────────

  async handleUndo(socket: Socket, io: Server, data: UndoRedoData) {
    const { boardId, userId } = data;

    // Lua script: atomically read and pop the first snapshot in one operation
    const luaAtomicPop = `
      local val = redis.call('lindex', KEYS[1], 0)
      if val then redis.call('lpop', KEYS[1]) end
      return val`;

    try {
      const hasAccess = await this.checkBoardAccess(boardId, userId, 'EDITOR');
      if (!hasAccess) {
        socket.emit('error', { message: 'Permission denied' });
        return;
      }

      // C2: User-namespaced undo key
      const snapshotStr = await redis.eval(luaAtomicPop, 1, `snapshots:${boardId}:${userId}`) as string | null;
      if (!snapshotStr) {
        return;
      }

      // Save current state to user's redo stack before restoring
      const currentSnapshot = await this.readCurrentSnapshot(boardId);
      // C2: User-namespaced redo key
      await redis.lpush(`redo:${boardId}:${userId}`, JSON.stringify(currentSnapshot));
      await redis.ltrim(`redo:${boardId}:${userId}`, 0, 49);

      const snapshot = JSON.parse(snapshotStr) as ElementSnapshot[];
      await this.restoreSnapshot(boardId, snapshot);

      io.to(`board:${boardId}`).emit('element:snapshot', snapshot);

      // C3: Emit actual stack depths back to the originating socket
      const undoDepth = await redis.llen(`snapshots:${boardId}:${userId}`);
      const redoDepth = await redis.llen(`redo:${boardId}:${userId}`);
      socket.emit('history:state', { undoDepth, redoDepth });

      logger.info('Undo applied', { boardId, userId, elementCount: snapshot.length });
    } catch (error) {
      logger.error('Error handling undo', { boardId, userId, error });
      socket.emit('error', { message: 'Failed to undo' });
    }
  }

  async handleRedo(socket: Socket, io: Server, data: UndoRedoData) {
    const { boardId, userId } = data;

    // Lua script: atomically read and pop the first redo snapshot
    const luaAtomicPop = `
      local val = redis.call('lindex', KEYS[1], 0)
      if val then redis.call('lpop', KEYS[1]) end
      return val`;

    try {
      const hasAccess = await this.checkBoardAccess(boardId, userId, 'EDITOR');
      if (!hasAccess) {
        socket.emit('error', { message: 'Permission denied' });
        return;
      }

      // C2: User-namespaced redo key
      const redoStr = await redis.eval(luaAtomicPop, 1, `redo:${boardId}:${userId}`) as string | null;
      if (!redoStr) {
        return;
      }

      // H4: Save current state back to undo stack; abort redo if lpush fails
      const currentSnapshot = await this.readCurrentSnapshot(boardId);
      // C2: User-namespaced undo key
      const pushed = await redis.lpush(`snapshots:${boardId}:${userId}`, JSON.stringify(currentSnapshot));
      if (!pushed) {
        socket.emit('error', { message: 'Failed to redo: could not save undo state' });
        return;
      }
      await redis.ltrim(`snapshots:${boardId}:${userId}`, 0, 49);

      const snapshot = JSON.parse(redoStr) as ElementSnapshot[];
      await this.restoreSnapshot(boardId, snapshot);

      io.to(`board:${boardId}`).emit('element:snapshot', snapshot);

      // C3: Emit actual stack depths back to the originating socket
      const undoDepth = await redis.llen(`snapshots:${boardId}:${userId}`);
      const redoDepth = await redis.llen(`redo:${boardId}:${userId}`);
      socket.emit('history:state', { undoDepth, redoDepth });

      logger.info('Redo applied', { boardId, userId, elementCount: snapshot.length });
    } catch (error) {
      logger.error('Error handling redo', { boardId, userId, error });
      socket.emit('error', { message: 'Failed to redo' });
    }
  }

  // ─── Clear board ─────────────────────────────────────────────────────────────

  async handleClearBoard(socket: Socket, io: Server, data: { boardId: string; userId: string }) {
    const { boardId, userId } = data;
    try {
      const hasAccess = await this.checkBoardAccess(boardId, userId, 'EDITOR');
      if (!hasAccess) {
        socket.emit('error', { message: 'Permission denied' });
        return;
      }

      // C1: Capture pre-mutation state BEFORE the DB write
      const preSnapshot = await this.readCurrentSnapshot(boardId);

      await prisma.element.deleteMany({ where: { boardId } });

      // C1: Save snapshot only on DB success; Redis failure is non-fatal
      try {
        await this.saveSnapshot(boardId, userId, preSnapshot);
      } catch (redisErr) {
        logger.warn('Snapshot save failed (non-fatal)', { boardId, error: redisErr });
      }

      io.to(`board:${boardId}`).emit('board:cleared');
      logger.info('Board cleared', { boardId, userId });
    } catch (error) {
      logger.error('Error clearing board', { boardId, userId, error });
      socket.emit('error', { message: 'Failed to clear board' });
    }
  }

  // ─── Access control ──────────────────────────────────────────────────────────

  private async checkBoardAccess(
    boardId: string,
    userId: string,
    requiredRole: Role
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
                role: { in: [requiredRole, Role.ADMIN] },
              },
            },
          },
        ],
      },
    });
    return !!board;
  }
}
