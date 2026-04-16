import { Server, Socket } from 'socket.io';
import redis from '../../config/redis';
import prisma from '../../config/database';
import logger from '../../config/logger';

interface JoinBoardData {
  boardId: string;
  userId: string;
  userName: string;
  userColor: string;
}

export class BoardEvents {
  async handleJoinBoard(socket: Socket, io: Server, data: JoinBoardData) {
    const { boardId, userId, userName, userColor } = data;

    try {
      // Verify user has access to board
      const board = await prisma.board.findFirst({
        where: {
          id: boardId,
          OR: [
            { ownerId: userId },
            { collaborators: { some: { userId } } },
            { isPublic: true }
          ]
        }
      });

      if (!board) {
        socket.emit('error', { message: 'Access denied to board' });
        return;
      }

      // Join Socket.io room
      socket.join(`board:${boardId}`);

      // Atomically: set user entry, refresh TTL, and read the full user map.
      // A Lua script runs as a single Redis command — no other client can observe
      // partial state between HSET and HGETALL, eliminating the race condition
      // where a concurrent join or leave would see a stale user list.
      const luaJoinUser = `
        redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
        redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
        return redis.call('HGETALL', KEYS[1])
      `;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawResult = await (redis as any).eval(
        luaJoinUser, 1,
        `active:board:${boardId}`,
        userId,
        JSON.stringify({ socketId: socket.id, userId, userName, userColor, cursor: { x: 0, y: 0 }, lastSeen: Date.now() }),
        '300'
      ) as string[];

      // HGETALL returns a flat [field, value, field, value, …] array from Lua
      const activeUsersMap: Record<string, string> = {};
      for (let i = 0; i < rawResult.length; i += 2) {
        activeUsersMap[rawResult[i]] = rawResult[i + 1];
      }
      const users = Object.values(activeUsersMap).map(u => JSON.parse(u));

      // Broadcast full user list to everyone in the room (including the new joiner).
      // Legacy events kept alongside for any clients still listening to them.
      io.to(`board:${boardId}`).emit('room:users', users);
      socket.to(`board:${boardId}`).emit('user:joined', { userId, userName, userColor });
      socket.emit('board:active_users', users);

      // Initialize undo/redo button state for this user after join/reconnect.
      const [undoDepth, redoDepth] = await Promise.all([
        redis.llen(`snapshots:${boardId}:${userId}`),
        redis.llen(`redo:${boardId}:${userId}`),
      ]);
      socket.emit('history:state', { undoDepth, redoDepth });

      logger.info('User joined board', { userName, boardId });
    } catch (error) {
      logger.error('Error joining board', { boardId, error });
      socket.emit('error', { message: 'Failed to join board' });
    }
  }

  async handleLeaveBoard(socket: Socket, io: Server, boardId: string, userId: string) {
    try {
      // Leave Socket.io room
      socket.leave(`board:${boardId}`);

      // Remove from Redis
      await redis.hdel(`active:board:${boardId}`, userId);

      // Get updated user list
      const remaining = await redis.hgetall(`active:board:${boardId}`);
      const users = Object.values(remaining ?? {}).map(u => JSON.parse(u));

      // Broadcast updated full list to remaining users. Legacy event kept for compat.
      io.to(`board:${boardId}`).emit('room:users', users);
      socket.to(`board:${boardId}`).emit('user:left', { userId });

      logger.info('User left board', { userId, boardId });
    } catch (error) {
      logger.error('Error leaving board', { boardId, userId, error });
    }
  }
}