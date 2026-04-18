/**
 * Creates a bare Express app with all REST routes wired up — no server.listen,
 * no Socket.io. Used by supertest in integration tests.
 *
 * Prisma and Redis must be mocked by the calling test file BEFORE this module
 * is imported (jest.mock is hoisted, so this happens automatically).
 */
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { AuthController } from '../../src/controllers/auth.controller';
import { authMiddleware } from '../../src/middleware/auth.middleware';
import { BoardController } from '../../src/controllers/board.controller';
import { AiController } from '../../src/controllers/ai.controller';

export function createTestApp() {
  const app = express();

  app.use(cors());
  app.use(cookieParser());
  app.use(express.json());

  const authController = new AuthController();
  const boardController = new BoardController();
  const aiController = new AiController();

  // Auth
  app.post('/api/auth/register', (req, res) => authController.register(req, res));
  app.post('/api/auth/login', (req, res) => authController.login(req, res));
  app.post('/api/auth/logout', (req, res) => authController.logout(req, res));
  app.get('/api/auth/profile', authMiddleware, (req, res) => authController.getProfile(req, res));

  // Public board routes (unauthenticated, isPublic boards only)
  app.get('/api/public/boards/:id', (req, res) => boardController.getPublicBoard(req, res));
  app.get('/api/public/boards/:id/elements', (req, res) => boardController.getPublicBoardElements(req, res));

  // Boards (protected)
  app.get('/api/boards', authMiddleware, (req, res) => boardController.getBoards(req, res));
  app.get('/api/boards/:id', authMiddleware, (req, res) => boardController.getBoard(req, res));
  app.get('/api/boards/:id/elements', authMiddleware, (req, res) => boardController.getBoardElements(req, res));
  app.post('/api/boards', authMiddleware, (req, res) => boardController.createBoard(req, res));
  app.patch('/api/boards/:id', authMiddleware, (req, res) => boardController.updateBoard(req, res));
  app.delete('/api/boards/:id', authMiddleware, (req, res) => boardController.deleteBoard(req, res));

  // AI
  app.post('/api/boards/:id/ai/cluster', authMiddleware, (req, res) => aiController.clusterElements(req, res));

  return app;
}
