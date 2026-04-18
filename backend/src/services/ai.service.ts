import crypto from 'crypto';
import CircuitBreaker from 'opossum';
import redis from '../config/redis';
import prisma from '../config/database';
import logger from '../config/logger';
import { Role } from '@prisma/client';

const CACHE_TTL = 3600; // 1 hour

function getMlServiceUrl(): string {
    return process.env.ML_SERVICE_URL || 'http://ml-service:5000';
}

export interface StickyNoteInput {
    id: string;
    text: string;
    x: number;
    y: number;
    width?: number;
    height?: number;
}

export type LayoutMode = 'preserve' | 'aggressive';

export interface ClusterOptions {
    layoutMode?: LayoutMode;
    alpha?: number;
    maxDisplacement?: number;
    noteWidth?: number;
    noteHeight?: number;
}

export interface ClusterResult {
    id: string;
    cluster: number;
    suggestedX: number;
    suggestedY: number;
}

export interface ClusterResponse {
    results: ClusterResult[];
    degraded: boolean;
}

function hashElements(elements: StickyNoteInput[], options?: ClusterOptions, k?: number): string {
    const sorted = [...elements].sort((a, b) => a.id.localeCompare(b.id));
    const content = sorted
        .map((e) => {
            const x = Math.round(e.x);
            const y = Math.round(e.y);
            const width = Math.round(e.width ?? 200);
            const height = Math.round(e.height ?? 200);
            return `${e.id}:${e.text}:${x}:${y}:${width}:${height}`;
        })
        .join('|');
    const optionsFingerprint = JSON.stringify({
        k: k ?? null,
        layoutMode: options?.layoutMode ?? 'preserve',
        alpha: options?.alpha ?? 0.35,
        maxDisplacement: options?.maxDisplacement ?? 400,
        noteWidth: options?.noteWidth ?? 200,
        noteHeight: options?.noteHeight ?? 200,
    });

    return crypto.createHash('md5').update(`${content}::${optionsFingerprint}`).digest('hex');
}

async function callMlService(elements: StickyNoteInput[], options?: ClusterOptions, k?: number): Promise<ClusterResult[]> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30_000);

    let response: Response;
    try {
        response = await fetch(`${getMlServiceUrl()}/cluster`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.ML_SERVICE_KEY}`,
            },
            body: JSON.stringify({ notes: elements, options, ...(k !== undefined ? { k } : {}) }),
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
    async clusterElements(
        boardId: string,
        userId: string,
        elements: StickyNoteInput[],
        options?: ClusterOptions,
        k?: number,
    ): Promise<ClusterResponse> {
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

        const hash = hashElements(elements, options, k);
        const cacheKey = `ai:cluster:${boardId}:${hash}`;

        const cached = await redis.get(cacheKey);
        if (cached) {
            try {
                return { results: JSON.parse(cached) as ClusterResult[], degraded: false };
            } catch (error) {
                logger.warn('Invalid cached AI cluster payload; evicting cache entry', {
                    boardId,
                    cacheKey,
                    error,
                });
                await (redis as unknown as { del: (key: string) => Promise<number> }).del(cacheKey).catch(() => undefined);
            }
        }

        try {
            const results = await mlBreaker.fire(elements, options, k);
            await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(results));
            return { results, degraded: false };
        } catch (error) {
            logger.warn('ML clustering failed; returning original positions', {
                boardId,
                userId,
                error,
            });
            return {
                results: elements.map((element) => ({
                id: element.id,
                cluster: 0,
                suggestedX: element.x,
                suggestedY: element.y,
                })),
                degraded: true,
            };
        }
    }
}
