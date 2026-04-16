/**
 * Unit tests for AuthService
 *
 * Strategy: mock Prisma + bcrypt at the module level.
 * generateToken / verifyToken use the real JWT implementation so we can assert
 * on the token format without needing a full integration setup.
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
    $disconnect: jest.fn(),
  },
}));

jest.mock('../../src/config/redis', () => ({
  __esModule: true,
  default: {
    ping: jest.fn().mockResolvedValue('PONG'),
    disconnect: jest.fn(),
  },
}));

// Mock bcrypt so tests run fast (no actual hashing)
jest.mock('bcryptjs', () => ({
  hash: jest.fn().mockResolvedValue('$hashed$password'),
  compare: jest.fn(),
}));

// ── Imports ──────────────────────────────────────────────────────────────────
import bcrypt from 'bcryptjs';
import prisma from '../../src/config/database';
import { AuthService } from '../../src/services/auth.service';
import { verifyToken } from '../../src/utils/jwt';

// ── Fixtures ─────────────────────────────────────────────────────────────────
const USER_ID   = 'user-uuid-001';
const USER_EMAIL = 'alice@example.com';
const USER_NAME  = 'Alice';
const RAW_PW     = 'securePassword123';
const HASHED_PW  = '$hashed$password';

const dbUser = {
  id: USER_ID,
  email: USER_EMAIL,
  name: USER_NAME,
  passwordHash: HASHED_PW,
  avatarUrl: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

// ── Tests ────────────────────────────────────────────────────────────────────
describe('AuthService', () => {
  let authService: AuthService;

  beforeEach(() => {
    authService = new AuthService();
  });

  // ── register ────────────────────────────────────────────────────────────────
  describe('register', () => {
    it('hashes the password and creates the user, returning a valid JWT', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.user.create as jest.Mock).mockResolvedValue({
        id: USER_ID,
        email: USER_EMAIL,
        name: USER_NAME,
        createdAt: new Date(),
      });

      const result = await authService.register(USER_EMAIL, RAW_PW, USER_NAME);

      expect(bcrypt.hash).toHaveBeenCalledWith(RAW_PW, 10);
      expect(prisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            email: USER_EMAIL,
            passwordHash: HASHED_PW,
            name: USER_NAME,
          }),
        })
      );
      expect(result.token).toBeDefined();
      const decoded = verifyToken(result.token);
      expect(decoded?.userId).toBe(USER_ID);
    });

    it('throws "User already exists" when the email is already registered', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(dbUser);

      await expect(
        authService.register(USER_EMAIL, RAW_PW, USER_NAME)
      ).rejects.toThrow('User already exists');

      expect(prisma.user.create).not.toHaveBeenCalled();
    });
  });

  // ── login ───────────────────────────────────────────────────────────────────
  describe('login', () => {
    it('returns user object and a valid JWT when credentials are correct', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(dbUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      const result = await authService.login(USER_EMAIL, RAW_PW);

      expect(bcrypt.compare).toHaveBeenCalledWith(RAW_PW, HASHED_PW);
      expect(result.user.id).toBe(USER_ID);
      expect(result.user.email).toBe(USER_EMAIL);
      const decoded = verifyToken(result.token);
      expect(decoded?.userId).toBe(USER_ID);
    });

    it('throws "Invalid credentials" when the user does not exist', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(authService.login(USER_EMAIL, RAW_PW)).rejects.toThrow(
        'Invalid credentials'
      );
    });

    it('throws "Invalid credentials" when the password is wrong', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(dbUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      await expect(authService.login(USER_EMAIL, 'wrongPassword')).rejects.toThrow(
        'Invalid credentials'
      );
    });

    it('does not expose passwordHash in the returned user object', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(dbUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      const result = await authService.login(USER_EMAIL, RAW_PW);

      expect((result.user as any).passwordHash).toBeUndefined();
    });
  });

  // ── JWT round-trip ──────────────────────────────────────────────────────────
  describe('JWT helpers', () => {
    it('generateToken produces a token that verifyToken can decode back to the userId', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.user.create as jest.Mock).mockResolvedValue({
        id: USER_ID,
        email: USER_EMAIL,
        name: USER_NAME,
        createdAt: new Date(),
      });

      const { token } = await authService.register(USER_EMAIL, RAW_PW, USER_NAME);
      const payload = verifyToken(token);

      expect(payload).not.toBeNull();
      expect(payload!.userId).toBe(USER_ID);
    });

    it('verifyToken returns null for a tampered token', () => {
      const result = verifyToken('header.payload.badsignature');
      expect(result).toBeNull();
    });
  });
});
