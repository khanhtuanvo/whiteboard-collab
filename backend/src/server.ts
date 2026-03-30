import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import http from 'http';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import prisma from './config/database';
import redis from './config/redis';
import logger from './config/logger';
import { AuthController } from './controllers/auth.controller';
import { authMiddleware } from './middleware/auth.middleware';
import { BoardController } from './controllers/board.controller';
import { AiController } from './controllers/ai.controller';
import { setupSocketHandlers } from './websocket/socket.handler';


dotenv.config();

const app = express();
const server = http.createServer(app);

//Socket.io
const io = new Server(server, {
    cors: {
        origin: process.env.FRONTEND_URL || 'http://localhost:3000',
        methods: ['GET', 'POST'],
    },
    maxHttpBufferSize: 1e6, // 1 MB — rejects oversized payloads before parsing
})

// Redis adapter — enables Socket.io to broadcast across multiple backend instances
const pubClient = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
const subClient = pubClient.duplicate();
io.adapter(createAdapter(pubClient, subClient));


const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });

//Middleware
app.use(helmet());
app.use(cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ limit: '1mb', extended: true }));

// Request logger
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        logger.info(`${req.method} ${req.path}`, { status: res.statusCode, ms: Date.now() - start });
    });
    next();
});

//Controllers
const authController = new AuthController();
const boardController = new BoardController();
const aiController = new AiController();


app.get('/health', async (_req, res) => {
    try {
        //Test db connection
        await prisma.$queryRaw`SELECT 1`;
        //Test redis connection
        await redis.ping();

        res.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            database: 'connected',
            redis: 'connected'
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        res.status(500).json({
            status: 'error',
            error: message
        });
    }
})


// Auth routes
app.post('/api/auth/register', authLimiter, (req, res) => authController.register(req, res));
app.post('/api/auth/login', authLimiter, (req, res) => authController.login(req, res));
app.get('/api/auth/profile', authMiddleware, (req, res) => authController.getProfile(req, res));
app.patch('/api/auth/profile', authMiddleware, (req, res) => authController.updateProfile(req, res));

// Protected route example
app.get('/api/test-protected', authMiddleware, (req, res) => {
  res.json({ message: 'This is a protected route', userId: req.userId });
});

// Public board routes (no auth — read-only, isPublic boards only)
app.get('/api/public/boards/:id', (req, res) => boardController.getPublicBoard(req, res));
app.get('/api/public/boards/:id/elements', (req, res) => boardController.getPublicBoardElements(req, res));

// Board routes (protected)
app.get('/api/boards', authMiddleware, (req, res) => boardController.getBoards(req, res));
app.get('/api/boards/:id', authMiddleware, (req, res) => boardController.getBoard(req, res));
app.get('/api/boards/:id/elements', authMiddleware, (req, res) => boardController.getBoardElements(req, res));
app.post('/api/boards', authMiddleware, (req, res) => boardController.createBoard(req, res));
app.patch('/api/boards/:id', authMiddleware, (req, res) => boardController.updateBoard(req, res));
app.delete('/api/boards/:id', authMiddleware, (req, res) => boardController.deleteBoard(req, res));
app.post('/api/boards/:id/collaborators', authMiddleware, (req, res) => boardController.addCollaborator(req, res));

// AI routes (protected)
app.post('/api/boards/:id/ai/cluster', authMiddleware, (req, res) => aiController.clusterElements(req, res));

// Logout — clears the httpOnly auth cookie
app.post('/api/auth/logout', (_req, res) => {
    res.clearCookie('token', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
    res.json({ message: 'Logged out' });
});

// Wire up all Socket.io handlers (auth, board, cursor, element events)
setupSocketHandlers(io);

// Global error handler — must be last middleware, catches any unhandled errors
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error('Unhandled error', { message: err.message, stack: err.stack });
    res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 4000;

server.listen(PORT, () => {
    logger.info(`Server running on PORT ${PORT}`);
});

//Graceful shutdown

process.on('SIGTERM', async () => {
    logger.info('SIGTERM received, closing connections...');
    await prisma.$disconnect();
    redis.disconnect();
    pubClient.disconnect();
    subClient.disconnect();
    server.close(() => {
        logger.info('Server closed');
        process.exit(0);
    });
});