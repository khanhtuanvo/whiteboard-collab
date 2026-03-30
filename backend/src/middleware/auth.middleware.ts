import { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../utils/jwt';
import redis from '../config/redis';
import logger from '../config/logger';

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
    // Prefer httpOnly cookie; fall back to Authorization: Bearer for API clients
    const cookieToken = req.cookies?.token as string | undefined;
    const authHeader = req.headers.authorization;
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : undefined;

    const token = cookieToken ?? bearerToken;

    if (!token) {
        return res.status(401).json({ error: 'No token provided' });
    }

    const decoded = verifyToken(token);

    if (!decoded) {
        return res.status(401).json({ error: 'Invalid token' });
    }

    // Check token blacklist (populated on logout).
    // Fail open if Redis is unavailable so a Redis outage does not take down auth.
    try {
        const blacklisted = await redis.get(`bl:${token}`);
        if (blacklisted) {
            return res.status(401).json({ error: 'Token has been revoked' });
        }
    } catch (err) {
        logger.warn('Redis blacklist check failed — proceeding without blacklist enforcement', { err });
    }

    req.userId = decoded.userId;
    next();
}