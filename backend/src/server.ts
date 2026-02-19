import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import http from 'http';
import { Server } from 'socket.io';
import prisma from './config/database';
import redis from './config/redis';
import { timeStamp } from 'console';
import { AuthController } from './controllers/auth.controller';
import { authMiddleware } from './middleware/auth.middleware';

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

//Controllers
const authController = new AuthController();

app.get('/health', async (req, res) => {
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

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    socket.on('disconnect', () => {
        console.log('User disconnected', socket.id);
    })
})

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