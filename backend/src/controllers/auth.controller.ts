import {Request, Response} from 'express';
import { AuthService } from '../services/auth.service';
import { z } from 'zod';
import { verifyToken } from '../utils/jwt';
import redis from '../config/redis';
import logger from '../config/logger';

// Base cookie attributes shared by set and clear operations
const COOKIE_SETTINGS = {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
};

const COOKIE_OPTIONS = {
    ...COOKIE_SETTINGS,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days, matches JWT_EXPIRES_IN default
};


const authService = new AuthService();

//Validation schemas
const updateProfileSchema = z.object({
    name: z.string().min(2).optional(),
    avatarUrl: z.string().url().refine(u => u.startsWith('https://'), {
        message: 'avatarUrl must use HTTPS',
    }).optional(),
});

const registerSchema = z.object({
    email: z.string().email(),
    password: z.string().min(6),
    name: z.string().min(2)
})

const loginSchema = z.object({
    email: z.string().email(),
    password: z.string(),
})

export class AuthController {
    async register(req: Request, res: Response){
        try {
            const {email, password, name} = registerSchema.parse(req.body);
            const result = await authService.register(email, password, name);
            res.cookie('token', result.token, COOKIE_OPTIONS);
            res.status(201).json({ user: result.user });
        } catch (error) {
            if (error instanceof z.ZodError){
                return res.status(400).json({error: error.issues});
            }
            const message = error instanceof Error ? error.message : 'Something went wrong';
            res.status(400).json({ error: message });
        }
    }

    async login(req: Request, res: Response){
        try {
            const {email, password} = loginSchema.parse(req.body);
            const result = await authService.login(email, password);
            res.cookie('token', result.token, COOKIE_OPTIONS);
            res.json({ user: result.user });
        } catch (error) {
            if (error instanceof z.ZodError) {
                return res.status(400).json({ error: error.issues});
            }
            const message = error instanceof Error ? error.message : 'Something went wrong';
            res.status(401).json({ error: message });
        }
    }

    async getProfile(req: Request, res: Response){
        try {
            const userId = req.userId!;
            const user = await authService.getProfile(userId);
            res.json(user);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Something went wrong';
            res.status(404).json({ error: message });
        }
    }

    async updateProfile(req: Request, res: Response){
        try {
            const userId = req.userId!;
            const data = updateProfileSchema.parse(req.body);
            const user = await authService.updateProfile(userId, data);
            res.json(user);
        } catch (error) {
            if (error instanceof z.ZodError) {
                return res.status(400).json({ error: error.issues });
            }
            const message = error instanceof Error ? error.message : 'Something went wrong';
            res.status(400).json({ error: message });
        }
    }

    async logout(req: Request, res: Response) {
        const token = req.cookies?.token as string | undefined;
        if (token) {
            const payload = verifyToken(token);
            if (payload?.exp) {
                const ttl = payload.exp - Math.floor(Date.now() / 1000);
                if (ttl > 0) {
                    try {
                        await redis.setex(`bl:${token}`, ttl, '1');
                    } catch (err) {
                        logger.warn('Failed to blacklist token on logout', { err });
                    }
                }
            }
        }
        res.clearCookie('token', COOKIE_SETTINGS);
        res.json({ message: 'Logged out' });
    }
}
