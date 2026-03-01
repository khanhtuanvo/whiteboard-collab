import { Server, Socket } from 'socket.io';
import { verifyToken } from '../utils/jwt';
import { BoardEvents } from './events/board.events';
import { CursorEvents } from './events/cursor.events';
import { ElementEvents } from './events/element.events';

const boardEvents = new BoardEvents();
const cursorEvents = new CursorEvents();
const elementEvents = new ElementEvents();

export function setupSocketHandlers(io: Server) {
  // Middleware: Authenticate socket connections
  io.use((socket, next) => {
    const token = socket.handshake.auth.token;

    if (!token) {
      return next(new Error('Authentication error'));
    }

    const decoded = verifyToken(token);
    if (!decoded) {
      return next(new Error('Invalid token'));
    }

    // Attach userId to socket
    (socket as any).userId = decoded.userId;
    next();
  });

  io.on('connection', (socket: Socket) => {
    const userId = (socket as any).userId;
    console.log(`🔌 User ${userId} connected (socket: ${socket.id})`);

    // Board events
    socket.on('board:join', (data) => {
      boardEvents.handleJoinBoard(socket, {
        ...data,
        userId
      });
    });

    socket.on('board:leave', (data) => {
      boardEvents.handleLeaveBoard(socket, data.boardId, userId);
    });

    // Cursor events
    socket.on('cursor:move', (data) => {
      cursorEvents.handleCursorMove(socket, {
        ...data,
        userId
      });
    });

    // Element events
    socket.on('element:create', (data) => {
      elementEvents.handleCreateElement(socket, io, {
        ...data,
        userId
      });
    });

    socket.on('element:update', (data) => {
      elementEvents.handleUpdateElement(socket, io, {
        ...data,
        userId
      });
    });

    socket.on('element:delete', (data) => {
      elementEvents.handleDeleteElement(socket, io, {
        ...data,
        userId
      });
    });

    // Handle disconnect
    socket.on('disconnect', async () => {
      console.log(`🔌 User ${userId} disconnected (socket: ${socket.id})`);

      // Clean up user from all boards they were in
      // Get rooms this socket was in
      const rooms = Array.from(socket.rooms);
      
      for (const room of rooms) {
        if (room.startsWith('board:')) {
          const boardId = room.replace('board:', '');
          await boardEvents.handleLeaveBoard(socket, boardId, userId);
        }
      }
    });
  });
}