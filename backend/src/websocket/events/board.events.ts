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

      // Add user to Redis active users
      await redis.hset(
        `active:board:${boardId}`,
        userId,
        JSON.stringify({
          socketId: socket.id,
          userId,
          userName,
          userColor,
          cursor: { x: 0, y: 0 },
          lastSeen: Date.now()
        })
      );

      // Set expiry for cleanup — 5 min is sufficient for presence data
      await redis.expire(`active:board:${boardId}`, 300);

      // Get full active user list
      const activeUsers = await redis.hgetall(`active:board:${boardId}`);
      const users = Object.values(activeUsers).map(u => JSON.parse(u));

      // Broadcast full user list to everyone in the room (including the new joiner).
      // Legacy events kept alongside for any clients still listening to them.
      io.to(`board:${boardId}`).emit('room:users', users);
      socket.to(`board:${boardId}`).emit('user:joined', { userId, userName, userColor });
      socket.emit('board:active_users', users);

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