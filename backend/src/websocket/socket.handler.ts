import { Server, Socket } from 'socket.io';
import { verifyToken } from '../utils/jwt';
import redis from '../config/redis';
import logger from '../config/logger';
import { BoardEvents } from './events/board.events';
import { CursorEvents } from './events/cursor.events';
import { ElementEvents } from './events/element.events';

// Max events allowed per user per second for each event type.
// Keyed by userId (not socketId) so limits apply across multiple tabs/connections.
const EVENT_RATE_LIMITS: Record<string, number> = {
  'element:create': 10,
  // Split update lanes so high-frequency live ticks cannot starve commit updates.
  'element:update_live': 90,
  'element:update_commit': 20,
  'element:delete': 10,
  'element:undo':    5,
  'element:redo':    5,
  'board:join':      5,
  'board:leave':     5,
  'board:clear':     2,
  'cursor:move':    30,
};

/**
 * Lua script: atomically INCR the counter and set a 1-second TTL on first call.
 * Returns the count after increment. Running as a Lua script prevents the
 * INCR/EXPIRE race where a crash between the two commands leaves a key that
 * never expires and permanently blocks the user.
 */
const LUA_RATE_LIMIT = `
  local count = redis.call('INCR', KEYS[1])
  if count == 1 then
    redis.call('EXPIRE', KEYS[1], 1)
  end
  return count
`;

/**
 * Returns true if the user is within their rate limit for the given event.
 * Uses Redis so limits are enforced across all connected tabs/processes.
 * Fails open on Redis error — rate limiting is a DoS mitigation, not a
 * security gate; a brief Redis outage should not disconnect legitimate users.
 */
async function checkRateLimit(userId: string, event: string): Promise<boolean> {
  const limit = EVENT_RATE_LIMITS[event];
  if (!limit) return true;
  try {
    const key = `ratelimit:user:${userId}:${event}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const count = await (redis as any).eval(LUA_RATE_LIMIT, 1, key) as number;
    return count <= limit;
  } catch (err) {
    logger.warn('Redis rate-limit check failed — failing open', { userId, event, err });
    return true;
  }
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
    logger.info('Socket connected', { userId, socketId: socket.id });

    async function rateGuard(event: string): Promise<boolean> {
      if (await checkRateLimit(userId, event)) return true;
      socket.emit('error', { message: 'Rate limit exceeded', event });
      logger.warn('Socket rate limit exceeded', { userId, event, socketId: socket.id });
      return false;
    }

    // Board events
    socket.on('board:join', async (data) => {
      if (!await rateGuard('board:join')) return;
      boardEvents.handleJoinBoard(socket, io, {
        ...data,
        userId
      });
    });

    socket.on('board:leave', async (data) => {
      if (!await rateGuard('board:leave')) return;
      boardEvents.handleLeaveBoard(socket, io, data.boardId, userId);
    });

    // Cursor events
    socket.on('cursor:move', async (data) => {
      if (!await rateGuard('cursor:move')) return;
      cursorEvents.handleCursorMove(socket, {
        ...data,
        userId
      });
    });

    // Element events
    socket.on('element:create', async (data) => {
      if (!await rateGuard('element:create')) return;
      elementEvents.handleCreateElement(socket, io, {
        ...data,
        userId
      });
    });

    socket.on('element:update', async (data) => {
      const eventKey = data?.live ? 'element:update_live' : 'element:update_commit';
      if (!await rateGuard(eventKey)) return;
      elementEvents.handleUpdateElement(socket, io, {
        ...data,
        userId
      });
    });

    socket.on('element:delete', async (data) => {
      if (!await rateGuard('element:delete')) return;
      elementEvents.handleDeleteElement(socket, io, {
        ...data,
        userId
      });
    });

    socket.on('element:undo', async (data) => {
      if (!await rateGuard('element:undo')) return;
      elementEvents.handleUndo(socket, io, {
        ...data,
        userId
      });
    });

    socket.on('element:redo', async (data) => {
      if (!await rateGuard('element:redo')) return;
      elementEvents.handleRedo(socket, io, {
        ...data,
        userId
      });
    });

    socket.on('board:clear', async (data) => {
      if (!await rateGuard('board:clear')) return;
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