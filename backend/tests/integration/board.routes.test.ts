/**
 * Integration tests for GET /api/boards/:id/elements
 *
 * Strategy: mock Prisma + Redis at the module level, then spin up the
 * Express app via createTestApp() and fire real HTTP requests with supertest.
 * No server.listen, no Socket.io, no real database.
 */

// ── Mocks (hoisted before imports) ──────────────────────────────────────────
jest.mock('../../src/config/database', () => ({
  __esModule: true,
  default: {
    board: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    element: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    $queryRaw: jest.fn().mockResolvedValue([{ 1: 1 }]),
    $disconnect: jest.fn(),
  },
}));

jest.mock('../../src/config/redis', () => ({
  __esModule: true,
  default: {
    ping: jest.fn().mockResolvedValue('PONG'),
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
import request from 'supertest';
import prisma from '../../src/config/database';
import { generateToken } from '../../src/utils/jwt';
import { createTestApp } from '../helpers/testApp';

// ── Suite ────────────────────────────────────────────────────────────────────
describe('GET /api/boards/:id/elements', () => {
  const app = createTestApp();

  const USER_ID = 'test-user-id';
  const BOARD_ID = 'test-board-id';
  let authToken: string;

  const mockBoard = {
    id: BOARD_ID,
    title: 'Test Board',
    ownerId: USER_ID,
    isPublic: false,
    thumbnailUrl: null,
    settings: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockElements = [
    {
      id: 'elem-1',
      boardId: BOARD_ID,
      type: 'RECTANGLE',
      properties: { x: 10, y: 20, width: 100, height: 50, fill: '#3b82f6' },
      zIndex: 0,
      createdBy: USER_ID,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: 'elem-2',
      boardId: BOARD_ID,
      type: 'CIRCLE',
      properties: { x: 200, y: 150, radius: 60, fill: '#10b981' },
      zIndex: 1,
      createdBy: USER_ID,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];

  beforeAll(() => {
    // generateToken uses JWT_SECRET env var or falls back to 'dev-secret-do-not-use-in-production'
    // which is the same secret used by authMiddleware — so this token will be accepted
    authToken = generateToken(USER_ID);
  });

  // ── 401 cases ──────────────────────────────────────────────────────────────
  it('returns 401 when no Authorization header is provided', async () => {
    const res = await request(app).get(`/api/boards/${BOARD_ID}/elements`);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('No token provided');
  });

  it('returns 401 when the Authorization header has an invalid token', async () => {
    const res = await request(app)
      .get(`/api/boards/${BOARD_ID}/elements`)
      .set('Authorization', 'Bearer this.is.not.valid');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid token');
  });

  // ── 404 case ───────────────────────────────────────────────────────────────
  it('returns 404 when the board does not exist or the user has no access', async () => {
    (prisma.board.findFirst as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/boards/${BOARD_ID}/elements`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/board not found or access denied/i);
  });

  // ── 200 case ───────────────────────────────────────────────────────────────
  it('returns 200 with elements array when the user is the board owner', async () => {
    (prisma.board.findFirst as jest.Mock).mockResolvedValue(mockBoard);
    (prisma.element.findMany as jest.Mock).mockResolvedValue(mockElements);

    const res = await request(app)
      .get(`/api/boards/${BOARD_ID}/elements`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].id).toBe('elem-1');
    expect(res.body[0].type).toBe('RECTANGLE');
    expect(res.body[1].id).toBe('elem-2');
    expect(res.body[1].type).toBe('CIRCLE');
  });
});
