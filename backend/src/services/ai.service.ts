import crypto from 'crypto';
import redis from '../config/redis';
import prisma from '../config/database';
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

        const response = await fetch(`${ML_SERVICE_URL}/cluster`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(elements),
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({ detail: 'ML service error' }));
            throw new Error((err as any).detail || 'ML service error');
        }

        const results = await response.json() as ClusterResult[];
        await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(results));
        return results;
    }
}
