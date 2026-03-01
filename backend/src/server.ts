import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import http from 'http';
import { Server } from 'socket.io';
import prisma from './config/database';
import redis from './config/redis';
import { AuthController } from './controllers/auth.controller';
import { authMiddleware } from './middleware/auth.middleware';
import { BoardController } from './controllers/board.controller';
import { setupSocketHandlers } from './websocket/socket.handler';


dotenv.config();

const app = express();
const server = http.createServer(app);

//Socket.io
const io = new Server(server, {
    cors: {
        origin: process.env.FRONTEND_URL || 'http://localhost:3000',
        methods: ['GET', 'POST'],
    }
})


//Middleware
app.use(cors());
app.use(express.json());

// Request logger
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        console.log(`[${req.method}] ${req.path} → ${res.statusCode} in ${Date.now() - start}ms`);
    });
    next();
});

//Controllers
const authController = new AuthController();
const boardController = new BoardController();


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
app.post('/api/auth/register', (req, res) => authController.register(req, res));
app.post('/api/auth/login', (req, res) => authController.login(req, res));
app.get('/api/auth/profile', authMiddleware, (req, res) => authController.getProfile(req, res));

// Protected route example
app.get('/api/test-protected', authMiddleware, (req, res) => {
  res.json({ message: 'This is a protected route', userId: (req as any).userId });
});

// Board routes (protected)
app.get('/api/boards', authMiddleware, (req, res) => boardController.getBoards(req, res));
app.get('/api/boards/:id', authMiddleware, (req, res) => boardController.getBoard(req, res));
app.get('/api/boards/:id/elements', authMiddleware, (req, res) => boardController.getBoardElements(req, res));
app.post('/api/boards', authMiddleware, (req, res) => boardController.createBoard(req, res));
app.patch('/api/boards/:id', authMiddleware, (req, res) => boardController.updateBoard(req, res));
app.delete('/api/boards/:id', authMiddleware, (req, res) => boardController.deleteBoard(req, res));

// Wire up all Socket.io handlers (auth, board, cursor, element events)
setupSocketHandlers(io);

// Global error handler — must be last middleware, catches any unhandled errors
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[Error]', err.stack ?? err.message);
    res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 4000;

server.listen(PORT, () => {
    console.log(`Server running on PORT ${PORT}`);
});

//Graceful shutdown

process.on('SIGTERM', async () => {
    console.log('SIGTERM received, closing connection...');
    await prisma.$disconnect();
    redis.disconnect()
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});