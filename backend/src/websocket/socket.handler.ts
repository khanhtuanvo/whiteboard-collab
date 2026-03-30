import { Server, Socket } from 'socket.io';
import { verifyToken } from '../utils/jwt';
import logger from '../config/logger';
import { BoardEvents } from './events/board.events';
import { CursorEvents } from './events/cursor.events';
import { ElementEvents } from './events/element.events';

// Max events allowed per socket per second for each event type.
const EVENT_RATE_LIMITS: Record<string, number> = {
  'element:create': 10,
  'element:update': 60, // live drag ticks are high-frequency
  'element:delete': 10,
  'element:undo':    5,
  'element:redo':    5,
  'board:join':      5,
  'board:leave':     5,
  'board:clear':     2,
  'cursor:move':    30,
};

/** Returns a per-socket checker. Each call to allowed(event) consumes one token. */
function makeSocketLimiter() {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return function allowed(event: string): boolean {
    const limit = EVENT_RATE_LIMITS[event];
    if (!limit) return true;
    const now = Date.now();
    const b = buckets.get(event);
    if (!b || now >= b.resetAt) {
      buckets.set(event, { count: 1, resetAt: now + 1000 });
      return true;
    }
    if (b.count >= limit) return false;
    b.count++;
    return true;
  };
}

interface AuthenticatedSocket extends Socket {
  data: {
    userId: string;
  };
}

const boardEvents = new BoardEvents();
const cursorEvents = new CursorEvents();
const elementEvents = new ElementEvents();

export function setupSocketHandlers(io: Server) {
  // Middleware: Authenticate socket connections via Bearer token or httpOnly cookie
  io.use((socket, next) => {
    let token = socket.handshake.auth.token as string | undefined;

    // Fallback: parse httpOnly cookie from the upgrade request
    if (!token) {
      const cookieHeader = socket.request.headers.cookie ?? '';
      for (const part of cookieHeader.split(';')) {
        const [k, ...v] = part.trim().split('=');
        if (k?.trim() === 'token') {
          token = decodeURIComponent(v.join('='));
          break;
        }
      }
    }

    if (!token) {
      return next(new Error('Authentication error'));
    }

    const decoded = verifyToken(token);
    if (!decoded) {
      return next(new Error('Invalid token'));
    }

    // Attach userId to socket
    socket.data.userId = decoded.userId;
    next();
  });

  io.on('connection', (socket: Socket) => {
    const userId = (socket as AuthenticatedSocket).data.userId;
    const checkLimit = makeSocketLimiter();
    logger.info('Socket connected', { userId, socketId: socket.id });

    function rateGuard(event: string): boolean {
      if (checkLimit(event)) return true;
      socket.emit('error', { message: 'Rate limit exceeded', event });
      logger.warn('Socket rate limit exceeded', { userId, event, socketId: socket.id });
      return false;
    }

    // Board events
    socket.on('board:join', (data) => {
      if (!rateGuard('board:join')) return;
      boardEvents.handleJoinBoard(socket, io, {
        ...data,
        userId
      });
    });

    socket.on('board:leave', (data) => {
      if (!rateGuard('board:leave')) return;
      boardEvents.handleLeaveBoard(socket, io, data.boardId, userId);
    });

    // Cursor events
    socket.on('cursor:move', (data) => {
      if (!rateGuard('cursor:move')) return;
      cursorEvents.handleCursorMove(socket, {
        ...data,
        userId
      });
    });

    // Element events
    socket.on('element:create', (data) => {
      if (!rateGuard('element:create')) return;
      elementEvents.handleCreateElement(socket, io, {
        ...data,
        userId
      });
    });

    socket.on('element:update', (data) => {
      if (!rateGuard('element:update')) return;
      elementEvents.handleUpdateElement(socket, io, {
        ...data,
        userId
      });
    });

    socket.on('element:delete', (data) => {
      if (!rateGuard('element:delete')) return;
      elementEvents.handleDeleteElement(socket, io, {
        ...data,
        userId
      });
    });

    socket.on('element:undo', (data) => {
      if (!rateGuard('element:undo')) return;
      elementEvents.handleUndo(socket, io, {
        ...data,
        userId
      });
    });

    socket.on('element:redo', (data) => {
      if (!rateGuard('element:redo')) return;
      elementEvents.handleRedo(socket, io, {
        ...data,
        userId
      });
    });

    socket.on('board:clear', (data) => {
      if (!rateGuard('board:clear')) return;
      elementEvents.handleClearBoard(socket, io, {
        ...data,
        userId,
      });
    });

    // Handle disconnect
    socket.on('disconnect', async () => {
      logger.info('Socket disconnected', { userId, socketId: socket.id });

      // Clean up user from all boards they were in
      // Get rooms this socket was in
      const rooms = Array.from(socket.rooms);
      
      for (const room of rooms) {
        if (room.startsWith('board:')) {
          const boardId = room.replace('board:', '');
          await boardEvents.handleLeaveBoard(socket, io, boardId, userId);
        }
      }
    });
  });
}