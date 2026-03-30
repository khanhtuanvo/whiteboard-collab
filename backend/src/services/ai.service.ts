import crypto from 'crypto';
import CircuitBreaker from 'opossum';
import redis from '../config/redis';
import prisma from '../config/database';
import logger from '../config/logger';
import { Role } from '@prisma/client';

const ML_SERVICE_URL = process.env.ML_SERVICE_URL || 'http://ml-service:5000';
const CACHE_TTL = 3600; // 1 hour

export interface StickyNoteInput {
    id: string;
    text: string;
    x: number;
    y: number;
}

export interface ClusterResult {
    id: string;
    cluster: number;
    suggestedX: number;
    suggestedY: number;
}

function hashElements(elements: StickyNoteInput[]): string {
    const sorted = [...elements].sort((a, b) => a.id.localeCompare(b.id));
    const content = sorted.map(e => `${e.id}:${e.text}`).join('|');
    return crypto.createHash('md5').update(content).digest('hex');
}

async function callMlService(elements: StickyNoteInput[]): Promise<ClusterResult[]> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30_000);

    let response: Response;
    try {
        response = await fetch(`${ML_SERVICE_URL}/cluster`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.ML_SERVICE_KEY}`,
            },
            body: JSON.stringify(elements),
            signal: controller.signal,
        });
    } catch (err: unknown) {
        clearTimeout(timeoutId);
        if (err instanceof Error && err.name === 'AbortError') {
            throw new Error('ML service timed out');
        }
        throw err;
    }
    clearTimeout(timeoutId);

    if (!response.ok) {
        interface MLError { detail?: string }
        const err = await response.json().catch((): MLError => ({ detail: 'ML service error' })) as MLError;
        throw new Error(err.detail || 'ML service error');
    }

    return response.json() as Promise<ClusterResult[]>;
}

// Open after 50 % failures in a 10-request window; retry after 30 s
const mlBreaker = new CircuitBreaker(callMlService, {
    errorThresholdPercentage: 50,
    resetTimeout: 30_000,
    timeout: 31_000, // slightly longer than fetch timeout so AbortError surfaces first
});

mlBreaker.on('open', () => logger.warn('ML circuit breaker opened — ML service unreachable'));
mlBreaker.on('halfOpen', () => logger.info('ML circuit breaker half-open — probing ML service'));
mlBreaker.on('close', () => logger.info('ML circuit breaker closed — ML service recovered'));

export class AiService {
    async clusterElements(boardId: string, userId: string, elements: StickyNoteInput[]): Promise<ClusterResult[]> {
        const board = await prisma.board.findFirst({
            where: {
                id: boardId,
                OR: [
                    { ownerId: userId },
                    {
                        collaborators: {
                            some: {
                                userId,
                                role: { in: [Role.EDITOR, Role.ADMIN] },
                            },
                        },
                    },
                ],
            },
        });

        if (!board) {
            throw new Error('Board not found or insufficient permissions');
        }

        const hash = hashElements(elements);
        const cacheKey = `ai:cluster:${boardId}:${hash}`;

        const cached = await redis.get(cacheKey);
        if (cached) {
            return JSON.parse(cached) as ClusterResult[];
        }

        const results = await mlBreaker.fire(elements);
        await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(results));
        return results;
    }
}
