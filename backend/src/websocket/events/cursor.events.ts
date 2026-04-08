import { Socket } from 'socket.io';
import redis from '../../config/redis';
import logger from '../../config/logger';

interface CursorMoveData {
  boardId: string;
  userId: string;
  x: number;
  y: number;
}

export class CursorEvents {
  async handleCursorMove(socket: Socket, data: CursorMoveData) {
    const { boardId, userId, x, y } = data;

    try {
      // Update cursor position in Redis
      const userKey = `active:board:${boardId}`;
      const userData = await redis.hget(userKey, userId);

      if (userData) {
        const user = JSON.parse(userData);
        user.cursor = { x, y };
        user.lastSeen = Date.now();

        await redis.hset(userKey, userId, JSON.stringify(user));
      }

      // Broadcast to others in room (exclude sender)
      socket.to(`board:${boardId}`).emit('cursor:update', {
        userId,
        x,
        y
      });
    } catch (error) {
      // Cursor errors are non-fatal: log and continue silently so a transient
      // Redis hiccup does not disconnect the user or disrupt other events.
      logger.error('Error updating cursor', { boardId, userId, error });
    }
  }
}