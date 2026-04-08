/**
 * Integration tests for the Socket.io event pipeline
 *
 * Scenario: connect → join board → create element → verify broadcast
 *
 * Strategy:
 *   - Mock Prisma and Redis at the module level (no real DB or cache needed)
 *   - Spin up an in-process http.Server + Socket.io server using the same
 *     setupSocketHandlers() function used in production
 *   - Use socket.io-client to drive two connected clients (owner + observer)
 *   - Assert on the events emitted back by the server
 *
 * The server is started once before all tests and torn down after.
 */

// ── Mocks (hoisted before imports) ──────────────────────────────────────────
jest.mock('../../src/config/database', () => ({
  __esModule: true,
  default: {
    board: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
    element: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
      aggregate: jest.fn(),
    },
    boardCollaborator: {
      findMany: jest.fn(),
    },
    $executeRaw: jest.fn().mockResolvedValue(1),
    $transaction: jest.fn(),
    $queryRaw: jest.fn().mockResolvedValue([{ 1: 1 }]),
    $disconnect: jest.fn(),
  },
}));

jest.mock('../../src/config/redis', () => ({
  __esModule: true,
  default: {
    ping: jest.fn().mockResolvedValue('PONG'),
    lpush: jest.fn().mockResolvedValue(1),
    ltrim: jest.fn().mockResolvedValue('OK'),
    llen: jest.fn().mockResolvedValue(1),
    rpush: jest.fn().mockResolvedValue(1),
    lindex: jest.fn().mockResolvedValue(null),
    lpop: jest.fn().mockResolvedValue(null),
    eval: jest.fn().mockResolvedValue([]),
    del: jest.fn().mockResolvedValue(1),
    hset: jest.fn().mockResolvedValue(1),
    hgetall: jest.fn().mockResolvedValue({}),
    hdel: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
    xadd: jest.fn().mockResolvedValue('ok'),
    publish: jest.fn().mockResolvedValue(1),
    zadd: jest.fn().mockResolvedValue(1),
    zremrangebyrank: jest.fn().mockResolvedValue(0),
    disconnect: jest.fn(),
  },
}));

// ── Imports ──────────────────────────────────────────────────────────────────
import http from 'http';
import { Server } from 'socket.io';
import io from 'socket.io-client';
import prisma from '../../src/config/database';
import { setupSocketHandlers } from '../../src/websocket/socket.handler';
import { generateToken } from '../../src/utils/jwt';

// ── Helpers ──────────────────────────────────────────────────────────────────
const BOARD_ID   = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const OWNER_ID   = 'owner-socket-test';
const VIEWER_ID  = 'viewer-socket-test';
const ELEMENT_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

/** Resolves when the socket emits the named event, or rejects on timeout. */
function waitForEvent<T>(socket: ReturnType<typeof io>, event: string, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout waiting for '${event}'`)), timeoutMs);
    socket.once(event, (data: T) => { clearTimeout(t); resolve(data); });
  });
}

/** Resolves once socket.connect() succeeds. */
function waitForConnect(socket: ReturnType<typeof io>): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
const mockBoard = {
  id: BOARD_ID,
  title: 'Socket Test Board',
  ownerId: OWNER_ID,
  isPublic: false,
  thumbnailUrl: null,
  settings: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  collaborators: [],
};

const mockElement = {
  id: ELEMENT_ID,
  boardId: BOARD_ID,
  type: 'RECTANGLE',
  properties: { x: 10, y: 20, width: 100, height: 50, fill: '#3b82f6' },
  zIndex: 1,
  createdBy: OWNER_ID,
  createdAt: new Date(),
  updatedAt: new Date(),
};

// ── Server lifecycle ─────────────────────────────────────────────────────────
let httpServer: http.Server;
let ioServer: Server;
let serverPort: number;

beforeAll((done) => {
  httpServer = http.createServer();
  ioServer = new Server(httpServer, { cors: { origin: '*' } });
  setupSocketHandlers(ioServer);

  httpServer.listen(0, () => {
    serverPort = (httpServer.address() as any).port;
    done();
  });
});

afterAll((done) => {
  ioServer.close();
  httpServer.close(done);
});

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('Socket.io event pipeline', () => {
  let ownerSocket: ReturnType<typeof io>;
  let viewerSocket: ReturnType<typeof io>;

  beforeEach(() => {
    const ownerToken = generateToken(OWNER_ID);
    const viewerToken = generateToken(VIEWER_ID);

    ownerSocket = io(`http://localhost:${serverPort}`, {
      auth: { token: ownerToken },
      autoConnect: false,
    });
    viewerSocket = io(`http://localhost:${serverPort}`, {
      auth: { token: viewerToken },
      autoConnect: false,
    });
  });

  afterEach(() => {
    ownerSocket.disconnect();
    viewerSocket.disconnect();
  });

  // ── connect ────────────────────────────────────────────────────────────────
  it('rejects connection when no auth token is provided', (done) => {
    const noAuthSocket = io(`http://localhost:${serverPort}`, {
      auth: {},
      autoConnect: false,
    });
    noAuthSocket.once('connect_error', (err: Error) => {
      expect(err.message).toMatch(/authentication error/i);
      noAuthSocket.disconnect();
      done();
    });
    noAuthSocket.connect();
  });

  it('connects successfully with a valid JWT', async () => {
    ownerSocket.connect();
    await waitForConnect(ownerSocket);
    expect(ownerSocket.connected).toBe(true);
  });

  // ── board:join ────────────────────────────────────────────────────────────
  it('sends board:active_users to the joining socket after board:join', async () => {
    (prisma.board.findFirst as jest.Mock).mockResolvedValue(mockBoard);
    (prisma.boardCollaborator.findMany as jest.Mock).mockResolvedValue([]);

    ownerSocket.connect();
    await waitForConnect(ownerSocket);

    const activeUsersPromise = waitForEvent<any[]>(ownerSocket, 'board:active_users');
    ownerSocket.emit('board:join', { boardId: BOARD_ID, userName: 'Owner', userColor: '#ff0000' });

    const users = await activeUsersPromise;
    expect(Array.isArray(users)).toBe(true);
  });

  it('emits history:state with undo/redo depths when joining a board', async () => {
    (prisma.board.findFirst as jest.Mock).mockResolvedValue(mockBoard);
    (prisma.boardCollaborator.findMany as jest.Mock).mockResolvedValue([]);

    const redisMock = (jest.requireMock('../../src/config/redis').default as { llen: jest.Mock });
    redisMock.llen.mockReset();
    redisMock.llen.mockResolvedValueOnce(3).mockResolvedValueOnce(1);

    ownerSocket.connect();
    await waitForConnect(ownerSocket);

    const historyStatePromise = waitForEvent<{ undoDepth: number; redoDepth: number }>(ownerSocket, 'history:state');
    ownerSocket.emit('board:join', { boardId: BOARD_ID, userName: 'Owner', userColor: '#ff0000' });

    const historyState = await historyStatePromise;
    expect(historyState).toEqual({ undoDepth: 3, redoDepth: 1 });
  });

  // ── element:create → broadcast ─────────────────────────────────────────────
  it('broadcasts element:created to all room members after element:create', async () => {
    (prisma.board.findFirst as jest.Mock).mockResolvedValue(mockBoard);
    (prisma.element.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.boardCollaborator.findMany as jest.Mock).mockResolvedValue([]);

    // $transaction mock: returns the new element
    (prisma.$transaction as jest.Mock).mockImplementation(async (fn: any) => {
      return fn({
        $executeRaw: jest.fn().mockResolvedValue(1),
        element: {
          aggregate: jest.fn().mockResolvedValue({ _max: { zIndex: 0 } }),
          create: jest.fn().mockResolvedValue(mockElement),
        },
      });
    });

    // Connect both clients
    ownerSocket.connect();
    viewerSocket.connect();
    await Promise.all([waitForConnect(ownerSocket), waitForConnect(viewerSocket)]);

    // Join the board — wait for each socket's acknowledgement before proceeding
    const ownerJoinAck  = waitForEvent<any[]>(ownerSocket,  'board:active_users');
    const viewerJoinAck = waitForEvent<any[]>(viewerSocket, 'board:active_users');
    ownerSocket.emit('board:join',  { boardId: BOARD_ID, userName: 'Owner',  userColor: '#ff0000' });
    viewerSocket.emit('board:join', { boardId: BOARD_ID, userName: 'Viewer', userColor: '#00ff00' });
    await Promise.all([ownerJoinAck, viewerJoinAck]);

    // Now both are in the room — listener first, then emit
    const broadcastPromise = waitForEvent<any>(viewerSocket, 'element:created');
    ownerSocket.emit('element:create', {
      boardId: BOARD_ID,
      id: ELEMENT_ID,
      type: 'RECTANGLE',
      properties: { x: 10, y: 20, width: 100, height: 50, fill: '#3b82f6' },
    });

    const created = await broadcastPromise;
    expect(created.id).toBe(ELEMENT_ID);
    expect(created.type).toBe('RECTANGLE');
  });

  // ── permission: non-owner with no collaborator access ────────────────────
  it('emits error when user has no board access', async () => {
    // Board is owned by someone else and user is not a collaborator
    (prisma.board.findFirst as jest.Mock).mockResolvedValue(null);

    ownerSocket.connect();
    await waitForConnect(ownerSocket);

    const errorPromise = waitForEvent<any>(ownerSocket, 'error');
    ownerSocket.emit('element:create', {
      boardId: BOARD_ID,
      type: 'RECTANGLE',
      properties: { x: 0, y: 0, width: 50, height: 50, fill: '#000' },
    });

    const err = await errorPromise;
    expect(err.message).toMatch(/permission denied/i);
  });
});
