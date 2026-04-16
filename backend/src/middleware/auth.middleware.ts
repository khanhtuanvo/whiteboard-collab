import { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../utils/jwt';
import redis from '../config/redis';
import logger from '../config/logger';

/**
 * Local in-memory fallback for the token blacklist.
 * Populated whenever Redis confirms a token is blacklisted so that a
 * subsequent Redis outage doesn't allow recently-revoked tokens through.
 * TTL matches the logout flow: tokens are blacklisted until JWT expiry,
 * so 60 s of local caching is a safe conservative window.
 */
const localBlacklistCache = new Map<string, number>(); // token → expiry timestamp (ms)
const LOCAL_CACHE_TTL_MS = 60_000;

function cacheBlacklistedToken(token: string): void {
    localBlacklistCache.set(token, Date.now() + LOCAL_CACHE_TTL_MS);
}

function isLocalBlacklisted(token: string): boolean {
    const expiry = localBlacklistCache.get(token);
    if (expiry === undefined) return false;
    if (Date.now() > expiry) {
        localBlacklistCache.delete(token);
        return false;
    }
    return true;
}

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
    // On Redis failure: check local cache — fail-closed if the token was recently
    // seen as blacklisted; fail-open only for tokens with no local record.
    try {
        const blacklisted = await redis.get(`bl:${token}`);
        if (blacklisted) {
            cacheBlacklistedToken(token); // keep local copy for Redis-outage fallback
            return res.status(401).json({ error: 'Token has been revoked' });
        }
    } catch (err) {
        logger.warn('Redis blacklist check failed — checking local cache', { err });
        if (isLocalBlacklisted(token)) {
            return res.status(401).json({ error: 'Token has been revoked' });
        }
        // Token not found in local cache: proceed with a warning.
        // A token that was never cached cannot be confirmed as revoked,
        // so we allow it rather than locking out all users during an outage.
        logger.warn('Token not in local blacklist cache — proceeding without full blacklist enforcement');
    }

    req.userId = decoded.userId;
    next();
}