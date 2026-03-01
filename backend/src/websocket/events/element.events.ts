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
}

interface DeleteElementData {
  boardId: string;
  elementId: string;
  userId: string;
}

export class ElementEvents {
  async handleCreateElement(socket: Socket, io: any, data: CreateElementData) {
    const { boardId, userId, type, properties } = data;

    try {
      // Check permission
      const hasAccess = await this.checkBoardAccess(boardId, userId, 'EDITOR');
      if (!hasAccess) {
        socket.emit('error', { message: 'Permission denied' });
        return;
      }

      // Generate element ID
      const elementId = uuidv4();

      if (!Object.values(ElementType).includes(type as ElementType)) {
        socket.emit('error', { message: 'Invalid element type' });
        return;
      }

      // Save to database
      const element = await prisma.element.create({
        data: {
          id: elementId,
          boardId,
          type: type as ElementType,
          properties,
          zIndex: 0,
          createdBy: userId
        }
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
        JSON.stringify({
          action: 'create',
          element
        })
      );

      // Broadcast to all users in room
      io.to(`board:${boardId}`).emit('element:created', element);

      console.log(`✅ Element ${elementId} created on board ${boardId}`);
    } catch (error) {
      console.error('Error creating element:', error);
      socket.emit('error', { message: 'Failed to create element' });
    }
  }

  async handleUpdateElement(socket: Socket, io: any, data: UpdateElementData) {
    const { boardId, elementId, userId, properties } = data;

    try {
      // Check permission
      const hasAccess = await this.checkBoardAccess(boardId, userId, 'EDITOR');
      if (!hasAccess) {
        socket.emit('error', { message: 'Permission denied' });
        return;
      }

      // Get current element for history
      const currentElement = await prisma.element.findUnique({
        where: { id: elementId }
      });

      if (!currentElement) {
        socket.emit('error', { message: 'Element not found' });
        return;
      }

      // Update in database
      const updatedElement = await prisma.element.update({
        where: { id: elementId },
        data: {
            properties: {
                ...(currentElement.properties as Record<string, unknown>),
                ...properties
            }
        }
      });

      // Add to history (Redis Sorted Set)
      await redis.zadd(
        `history:${boardId}:${userId}`,
        Date.now(),
        JSON.stringify({
          action: 'update',
          elementId,
          before: currentElement.properties,
          after: updatedElement.properties
        })
      );

      // Keep only last 50 actions
      await redis.zremrangebyrank(`history:${boardId}:${userId}`, 0, -51);

      // Add to event stream
      await redis.xadd(
        `events:board:${boardId}`,
        '*',
        'action', 'update',
        'elementId', elementId,
        'userId', userId,
        'data', JSON.stringify(properties),
        'timestamp', Date.now().toString()
      );

      // Broadcast to all users
      io.to(`board:${boardId}`).emit('element:updated', {
        id: elementId,
        properties: updatedElement.properties
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
      // Check permission
      const hasAccess = await this.checkBoardAccess(boardId, userId, 'EDITOR');
      if (!hasAccess) {
        socket.emit('error', { message: 'Permission denied' });
        return;
      }

      // Get element before deleting (for undo)
      const element = await prisma.element.findUnique({
        where: { id: elementId }
      });

      if (!element) {
        socket.emit('error', { message: 'Element not found' });
        return;
      }

      // Delete from database
      await prisma.element.delete({
        where: { id: elementId }
      });

      // Add to history for undo
      await redis.zadd(
        `history:${boardId}:${userId}`,
        Date.now(),
        JSON.stringify({
          action: 'delete',
          elementId,
          element: element
        })
      );

      // Add to event stream
      await redis.xadd(
        `events:board:${boardId}`,
        '*',
        'action', 'delete',
        'elementId', elementId,
        'userId', userId,
        'timestamp', Date.now().toString()
      );

      // Broadcast to all users
      io.to(`board:${boardId}`).emit('element:deleted', { id: elementId });

      console.log(`✅ Element ${elementId} deleted`);
    } catch (error) {
      console.error('Error deleting element:', error);
      socket.emit('error', { message: 'Failed to delete element' });
    }
  }

  private async checkBoardAccess(
    boardId: string,
    userId: string,
    requiredRole: string
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
                role: { in: ['EDITOR', 'ADMIN'] }
              }
            }
          }
        ]
      }
    });

    return !!board;
  }
}