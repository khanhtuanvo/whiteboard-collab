import { Socket, Server } from 'socket.io';
import redis from '../../config/redis';
import prisma from '../../config/database';
import logger from '../../config/logger';
import { v4 as uuidv4 } from 'uuid';
import { ElementType, Role, Prisma } from '@prisma/client';
import { z } from 'zod';
const uuidSchema = z.string().uuid();

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
   * F3 — Lua-atomic saveSnapshot.
   *
   * All three Redis operations (LPUSH, LTRIM, DEL) execute in a single Lua
   * script. Unlike MULTI/EXEC, a Lua script is guaranteed to run atomically
   * and cannot be partially committed: if Redis crashes mid-script the entire
   * script is rolled back on recovery. This prevents the redo stack from
   * surviving a new mutation when a crash occurs between LTRIM and DEL.
   */
  private async saveSnapshot(boardId: string, userId: string, snapshot: ElementSnapshot[]): Promise<void> {
    const snapshotKey = `snapshots:${boardId}:${userId}`;
    const redoKey = `redo:${boardId}:${userId}`;
    const serialized = JSON.stringify(snapshot);

    const luaSave = `
      redis.call('LPUSH', KEYS[1], ARGV[1])
      redis.call('LTRIM', KEYS[1], 0, 49)
      redis.call('DEL', KEYS[2])
    `;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (redis as any).eval(luaSave, 2, snapshotKey, redoKey, serialized);
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
            properties: (el.properties ?? Prisma.JsonNull) as Prisma.InputJsonValue | Prisma.NullTypes.JsonNull,
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
      if (!uuidSchema.safeParse(boardId).success) {
        socket.emit('error', { message: 'Invalid board ID' });
        return;
      }

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
        // Inform the originating client of the new undo stack depth so canUndo
        // becomes true immediately after the first mutation (redo is 0 because
        // saveSnapshot always clears it).
        const undoDepth = await redis.llen(`snapshots:${boardId}:${userId}`);
        socket.emit('history:state', { undoDepth, redoDepth: 0 });
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
      if (!uuidSchema.safeParse(boardId).success) {
        socket.emit('error', { message: 'Invalid board ID' });
        return;
      }
      if (!uuidSchema.safeParse(elementId).success) {
        socket.emit('error', { message: 'Invalid element ID' });
        return;
      }

      const hasAccess = await this.checkBoardAccess(boardId, userId, 'EDITOR');
      if (!hasAccess) {
        socket.emit('error', { message: 'Permission denied' });
        return;
      }

      // Extract zIndex before schema validation — it's a top-level DB column, not a
      // JSON property, so PropertiesSchema (strict) would reject it as an unknown key.
      const rawPayload = properties as unknown as Record<string, unknown>;
      const incomingZIndex =
        typeof rawPayload.zIndex === 'number' && Number.isFinite(rawPayload.zIndex)
          ? rawPayload.zIndex
          : undefined;
      const { zIndex: _, ...propertiesWithoutZIndex } = rawPayload;

      // F5/F6: Validate BEFORE live branch — unvalidated properties must never be broadcast.
      const propertiesResult = PropertiesSchema.safeParse(propertiesWithoutZIndex);
      if (!propertiesResult.success) {
        socket.emit('error', { message: 'Invalid properties', details: propertiesResult.error.issues });
        return;
      }

      // F6: Live drag ticks skip the DB read entirely. The access check above is the
      // authorization gate; the socket can only be in room board:${boardId} if it was
      // admitted by the join handler. The boardId+elementId ownership is verified on
      // the gesture-end (commit) tick that always follows.
      if (live) {
        io.to(`board:${boardId}`).emit('element:updated', {
          id: elementId,
          properties: propertiesResult.data,  // F5: broadcast validated data, not raw input
        });
        return;
      }

      // F6: DB read only on the commit (non-live) path
      const currentElement = await prisma.element.findUnique({
        where: { id: elementId },
      });

      if (!currentElement || currentElement.boardId !== boardId) {
        socket.emit('error', { message: 'Element not found' });
        return;
      }

      // C1: Capture pre-mutation state BEFORE the DB write
      const preSnapshot = await this.readCurrentSnapshot(boardId);

      // F4 + F5: Return a struct from the transaction so beforeProperties is captured
      // from the same transactional read as the update, eliminating the TOCTOU window
      // that existed when currentElement (fetched outside) was used as the "before" value.
      const { updatedElement, beforeProperties } = await prisma.$transaction(async (tx) => {
        const elem = await tx.element.findUnique({ where: { id: elementId } });
        if (!elem) throw new Error('Element not found');

        const before = elem.properties;

        // F5: Guard against non-object JSON values (null, primitives, arrays) stored
        // in the DB. Spreading a non-object silently drops existing properties.
        const existing =
          typeof elem.properties === 'object' &&
          elem.properties !== null &&
          !Array.isArray(elem.properties)
            ? (elem.properties as Record<string, unknown>)
            : {};

        const updateData: Prisma.ElementUpdateInput = {
          properties: {
            ...existing,
            ...propertiesResult.data,  // F5: use validated data, not raw properties
          },
        };

        // Write zIndex to the dedicated DB column when provided (e.g. bring-to-front / send-to-back).
        if (incomingZIndex !== undefined) {
          updateData.zIndex = incomingZIndex;
        }

        const updated = await tx.element.update({
          where: { id: elementId },
          data: updateData,
        });

        return { updatedElement: updated, beforeProperties: before };
      });

      // C1: Save snapshot only on DB success; Redis failure is non-fatal
      try {
        await this.saveSnapshot(boardId, userId, preSnapshot);
        const undoDepth = await redis.llen(`snapshots:${boardId}:${userId}`);
        socket.emit('history:state', { undoDepth, redoDepth: 0 });
      } catch (redisErr) {
        logger.warn('Snapshot save failed (non-fatal)', { boardId, error: redisErr });
      }

      // F4: Use beforeProperties from inside the transaction — not the outer
      // currentElement.properties which was fetched before acquiring the tx lock.
      await redis.zadd(
        `history:${boardId}:${userId}`,
        Date.now(),
        JSON.stringify({
          action: 'update',
          elementId,
          before: beforeProperties,
          after: updatedElement.properties,
        })
      );
      await redis.zremrangebyrank(`history:${boardId}:${userId}`, 0, -51);

      await xaddCapped(`events:board:${boardId}`, 1000, {
        action: 'update',
        elementId,
        userId,
        data: JSON.stringify(propertiesResult.data),  // F5: validated data
        timestamp: Date.now().toString(),
      });

      io.to(`board:${boardId}`).emit('element:updated', {
        id: elementId,
        properties: updatedElement.properties,
        zIndex: updatedElement.zIndex,
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
      if (!uuidSchema.safeParse(boardId).success) {
        socket.emit('error', { message: 'Invalid board ID' });
        return;
      }
      if (!uuidSchema.safeParse(elementId).success) {
        socket.emit('error', { message: 'Invalid element ID' });
        return;
      }

      const hasAccess = await this.checkBoardAccess(boardId, userId, 'EDITOR');
      if (!hasAccess) {
        socket.emit('error', { message: 'Permission denied' });
        return;
      }

      const element = await prisma.element.findUnique({
        where: { id: elementId },
      });

      if (!element || element.boardId !== boardId) {
        socket.emit('error', { message: 'Element not found' });
        return;
      }

      // C1: Capture pre-mutation state BEFORE the DB write
      const preSnapshot = await this.readCurrentSnapshot(boardId);

      await prisma.element.delete({ where: { id: elementId } });

      // C1: Save snapshot only on DB success; Redis failure is non-fatal
      try {
        await this.saveSnapshot(boardId, userId, preSnapshot);
        const undoDepth = await redis.llen(`snapshots:${boardId}:${userId}`);
        socket.emit('history:state', { undoDepth, redoDepth: 0 });
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
    const undoKey = `snapshots:${boardId}:${userId}`;
    const redoKey = `redo:${boardId}:${userId}`;

    // Lua script: atomically peek-and-pop — avoids a separate LINDEX + LPOP race.
    const luaAtomicPop = `
      local val = redis.call('lindex', KEYS[1], 0)
      if val then redis.call('lpop', KEYS[1]) end
      return val`;

    try {
      if (!uuidSchema.safeParse(boardId).success) {
        socket.emit('error', { message: 'Invalid board ID' });
        return;
      }

      const hasAccess = await this.checkBoardAccess(boardId, userId, 'EDITOR');
      if (!hasAccess) {
        socket.emit('error', { message: 'Permission denied' });
        return;
      }

      const snapshotStr = await redis.eval(luaAtomicPop, 1, undoKey) as string | null;
      if (!snapshotStr) return;

      const currentSnapshot = await this.readCurrentSnapshot(boardId);
      const snapshot = JSON.parse(snapshotStr) as ElementSnapshot[];

      // F1: Restore first. If it fails, re-push the entry so it is not permanently
      // lost. The re-push is best-effort — if it also fails, the entry is gone and
      // we log the loss; the throw propagates to the outer catch which emits an error.
      try {
        await this.restoreSnapshot(boardId, snapshot);
      } catch (restoreErr) {
        await redis.lpush(undoKey, snapshotStr);
        throw restoreErr;
      }

      // F1: Restore succeeded — commit the redo push atomically (lpush + ltrim
      // in one MULTI/EXEC so the list cannot exceed 50 even if the process dies
      // between the two commands).
      await redis.multi()
        .lpush(redoKey, JSON.stringify(currentSnapshot))
        .ltrim(redoKey, 0, 49)
        .exec();

      io.to(`board:${boardId}`).emit('element:snapshot', snapshot);

      const [undoDepth, redoDepth] = await Promise.all([
        redis.llen(undoKey),
        redis.llen(redoKey),
      ]);
      socket.emit('history:state', { undoDepth, redoDepth });

      logger.info('Undo applied', { boardId, userId, elementCount: snapshot.length });
    } catch (error) {
      logger.error('Error handling undo', { boardId, userId, error });
      socket.emit('error', { message: 'Failed to undo' });
    }
  }

  async handleRedo(socket: Socket, io: Server, data: UndoRedoData) {
    const { boardId, userId } = data;
    const undoKey = `snapshots:${boardId}:${userId}`;
    const redoKey = `redo:${boardId}:${userId}`;

    // Lua script: atomically peek-and-pop the redo entry.
    const luaAtomicPop = `
      local val = redis.call('lindex', KEYS[1], 0)
      if val then redis.call('lpop', KEYS[1]) end
      return val`;

    try {
      if (!uuidSchema.safeParse(boardId).success) {
        socket.emit('error', { message: 'Invalid board ID' });
        return;
      }

      const hasAccess = await this.checkBoardAccess(boardId, userId, 'EDITOR');
      if (!hasAccess) {
        socket.emit('error', { message: 'Permission denied' });
        return;
      }

      const redoStr = await redis.eval(luaAtomicPop, 1, redoKey) as string | null;
      if (!redoStr) return;

      const currentSnapshot = await this.readCurrentSnapshot(boardId);
      const snapshot = JSON.parse(redoStr) as ElementSnapshot[];

      // F2: Restore first. If it fails, re-push the redo entry so it is not lost.
      try {
        await this.restoreSnapshot(boardId, snapshot);
      } catch (restoreErr) {
        await redis.lpush(redoKey, redoStr);
        throw restoreErr;
      }

      // F2: Restore succeeded — push current state back to undo.
      // This is non-fatal: the board is already correctly restored. If the undo push
      // fails, the user simply cannot undo this redo; they are not left with a
      // corrupted board. The dead `if (!pushed)` check has been removed — lpush
      // returns the list length (always ≥ 1 on success) and throws on failure.
      try {
        await redis.multi()
          .lpush(undoKey, JSON.stringify(currentSnapshot))
          .ltrim(undoKey, 0, 49)
          .exec();
      } catch (redisErr) {
        logger.warn('Redo undo-push failed (non-fatal): board restored but undo entry lost', {
          boardId,
          error: redisErr,
        });
      }

      io.to(`board:${boardId}`).emit('element:snapshot', snapshot);

      const [undoDepth, redoDepth] = await Promise.all([
        redis.llen(undoKey),
        redis.llen(redoKey),
      ]);
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
      if (!uuidSchema.safeParse(boardId).success) {
        socket.emit('error', { message: 'Invalid board ID' });
        return;
      }

      // Clearing the entire board is a destructive operation — restrict to OWNER and ADMIN.
      // Regular EDITORs cannot wipe another user's work.
      const hasAccess = await this.checkBoardAccess(boardId, userId, Role.ADMIN);
      if (!hasAccess) {
        socket.emit('error', { message: 'Only board owners and admins can clear the board' });
        return;
      }

      // C1: Capture pre-mutation state BEFORE the DB write
      const preSnapshot = await this.readCurrentSnapshot(boardId);

      await prisma.element.deleteMany({ where: { boardId } });

      // C1: Save snapshot only on DB success; Redis failure is non-fatal
      try {
        await this.saveSnapshot(boardId, userId, preSnapshot);
        const undoDepth = await redis.llen(`snapshots:${boardId}:${userId}`);
        socket.emit('history:state', { undoDepth, redoDepth: 0 });
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
