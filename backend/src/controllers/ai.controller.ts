import { Request, Response } from 'express';
import { z } from 'zod';
import { AiService } from '../services/ai.service';

const aiService = new AiService();

const uuidSchema = z.string().uuid();

const clusterInputSchema = z.array(
    z.object({
        id: z.string(),
        text: z.string(),
        x: z.number(),
        y: z.number(),
    })
);

export class AiController {
    async clusterElements(req: Request, res: Response) {
        try {
            const boardId = req.params.id as string;
            if (!uuidSchema.safeParse(boardId).success) {
                return res.status(400).json({ error: 'Invalid board ID' });
            }
            const userId = req.userId!;
            const elements = clusterInputSchema.parse(req.body);

            if (elements.length < 3) {
                return res.status(400).json({ error: 'Minimum 3 sticky notes required' });
            }

            const results = await aiService.clusterElements(boardId, userId, elements);
            res.json(results);
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
