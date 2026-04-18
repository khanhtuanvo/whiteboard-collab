import { Request, Response } from 'express';
import { z } from 'zod';
import { AiService } from '../services/ai.service';

const aiService = new AiService();

const uuidSchema = z.string().uuid();

const clusterElementSchema = z.object({
    id: z.string(),
    text: z.string(),
    x: z.number(),
    y: z.number(),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
});

const clusterOptionsSchema = z.object({
    layoutMode: z.enum(['preserve', 'aggressive']).optional(),
    alpha: z.number().min(0).max(1).optional(),
    maxDisplacement: z.number().min(0).max(5000).optional(),
    noteWidth: z.number().positive().optional(),
    noteHeight: z.number().positive().optional(),
}).optional();

const clusterRequestSchema = z.union([
    z.array(clusterElementSchema),
    z.object({
        notes: z.array(clusterElementSchema),
        options: clusterOptionsSchema,
        k: z.number().int().min(2).max(50).optional(),
    }),
]);

export class AiController {
    async clusterElements(req: Request, res: Response) {
        try {
            const boardId = req.params.id as string;
            if (!uuidSchema.safeParse(boardId).success) {
                return res.status(400).json({ error: 'Invalid board ID' });
            }
            const userId = req.userId!;
            const payload = clusterRequestSchema.parse(req.body);
            const elements = Array.isArray(payload) ? payload : payload.notes;
            const options = Array.isArray(payload) ? undefined : payload.options;
            const k = Array.isArray(payload) ? undefined : payload.k;

            if (elements.length < 3) {
                return res.status(400).json({ error: 'Minimum 3 sticky notes required' });
            }

            const result = await aiService.clusterElements(boardId, userId, elements, options, k);
            res.json(result);
        } catch (error) {
            if (error instanceof z.ZodError) {
                return res.status(400).json({ error: error.issues });
            }
            const message = error instanceof Error ? error.message : 'Unknown error';
            const status = message.includes('permissions') ? 403 : 500;
            res.status(status).json({ error: message });
        }
    }
}
