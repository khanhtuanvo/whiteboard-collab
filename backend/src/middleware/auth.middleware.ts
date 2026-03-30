import { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../utils/jwt';

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
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

    req.userId = decoded.userId;
    next();
}