import { Socket } from 'socket.io';
import redis from '../../config/redis';

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
      console.error('Error updating cursor:', error);
    }
  }
}