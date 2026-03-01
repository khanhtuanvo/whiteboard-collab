import { Socket } from 'socket.io';
import redis from '../../config/redis';
import prisma from '../../config/database';

interface JoinBoardData {
  boardId: string;
  userId: string;
  userName: string;
  userColor: string;
}

export class BoardEvents {
  async handleJoinBoard(socket: Socket, data: JoinBoardData) {
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

      // Set expiry for cleanup
      await redis.expire(`active:board:${boardId}`, 3600); // 1 hour

      // Get all active users
      const activeUsers = await redis.hgetall(`active:board:${boardId}`);
      const users = Object.values(activeUsers).map(u => JSON.parse(u));

      // Notify all users in room
      socket.to(`board:${boardId}`).emit('user:joined', {
        userId,
        userName,
        userColor
      });

      // Send current active users to joining user
      socket.emit('board:active_users', users);

      console.log(`✅ User ${userName} joined board ${boardId}`);
    } catch (error) {
      console.error('Error joining board:', error);
      socket.emit('error', { message: 'Failed to join board' });
    }
  }

  async handleLeaveBoard(socket: Socket, boardId: string, userId: string) {
    try {
      // Leave Socket.io room
      socket.leave(`board:${boardId}`);

      // Remove from Redis
      await redis.hdel(`active:board:${boardId}`, userId);

      // Notify others
      socket.to(`board:${boardId}`).emit('user:left', { userId });

      console.log(`User ${userId} left board ${boardId}`);
    } catch (error) {
      console.error('Error leaving board:', error);
    }
  }
}