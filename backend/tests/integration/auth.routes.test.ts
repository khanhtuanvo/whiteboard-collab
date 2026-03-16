/**
 * Integration tests for POST /api/auth/register and POST /api/auth/login
 *
 * Strategy: mock Prisma + bcrypt + Redis at the module level, then spin up
 * the Express app via createTestApp() and fire real HTTP requests with supertest.
 */

// ── Mocks (hoisted before imports) ──────────────────────────────────────────
jest.mock('../../src/config/database', () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    board: { findFirst: jest.fn(), findMany: jest.fn() },
    element: { findMany: jest.fn() },
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

jest.mock('bcryptjs', () => ({
  hash: jest.fn().mockResolvedValue('$hashed$password'),
  compare: jest.fn(),
}));

// ── Imports ──────────────────────────────────────────────────────────────────
import request from 'supertest';
import bcrypt from 'bcryptjs';
import prisma from '../../src/config/database';
import { verifyToken } from '../../src/utils/jwt';
import { createTestApp } from '../helpers/testApp';

// ── Fixtures ──────────────────────────────────────────────────────────────────
const USER_ID   = 'user-uuid-register-test';
const USER_EMAIL = 'bob@example.com';
const USER_NAME  = 'Bob';
const RAW_PW    = 'password123';
const HASHED_PW = '$hashed$password';

const storedUser = {
  id: USER_ID,
  email: USER_EMAIL,
  name: USER_NAME,
  passwordHash: HASHED_PW,
  avatarUrl: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

// ── Suite ─────────────────────────────────────────────────────────────────────
describe('Auth routes', () => {
  const app = createTestApp();

  // ── POST /api/auth/register ─────────────────────────────────────────────────
  describe('POST /api/auth/register', () => {
    it('returns 201 with user + JWT token on valid registration', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.user.create as jest.Mock).mockResolvedValue({
        id: USER_ID,
        email: USER_EMAIL,
        name: USER_NAME,
        createdAt: new Date(),
      });

      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: USER_EMAIL, password: RAW_PW, name: USER_NAME });

      expect(res.status).toBe(201);
      expect(res.body.token).toBeDefined();
      expect(res.body.user.email).toBe(USER_EMAIL);
      expect(res.body.user.name).toBe(USER_NAME);
      // passwordHash must never appear in the response
      expect(res.body.user.passwordHash).toBeUndefined();
      // Token must decode to the created user's id
      const decoded = verifyToken(res.body.token);
      expect(decoded?.userId).toBe(USER_ID);
    });

    it('returns 400 when email is missing', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ password: RAW_PW, name: USER_NAME });

      expect(res.status).toBe(400);
    });

    it('returns 400 when password is shorter than 6 characters', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: USER_EMAIL, password: '123', name: USER_NAME });

      expect(res.status).toBe(400);
    });

    it('returns 400 when the email is already registered', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(storedUser);

      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: USER_EMAIL, password: RAW_PW, name: USER_NAME });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/user already exists/i);
    });
  });

  // ── POST /api/auth/login ────────────────────────────────────────────────────
  describe('POST /api/auth/login', () => {
    it('returns 200 with user + JWT token on valid credentials', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(storedUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: USER_EMAIL, password: RAW_PW });

      expect(res.status).toBe(200);
      expect(res.body.token).toBeDefined();
      expect(res.body.user.id).toBe(USER_ID);
      expect(res.body.user.email).toBe(USER_EMAIL);
      expect(res.body.user.passwordHash).toBeUndefined();
    });

    it('returns 401 when the user does not exist', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);

      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'nobody@example.com', password: RAW_PW });

      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/invalid credentials/i);
    });

    it('returns 401 when the password is incorrect', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(storedUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: USER_EMAIL, password: 'wrongpassword' });

      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/invalid credentials/i);
    });

    it('returns 400 when the request body is missing required fields', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: USER_EMAIL }); // missing password

      expect(res.status).toBe(400);
    });
  });
});
