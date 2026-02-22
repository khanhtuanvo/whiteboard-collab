import { Request, Response } from 'express';
import { BoardService } from '../services/board.service';
import { z } from 'zod';

const boardService = new BoardService();

const createBoardSchema = z.object({
  title: z.string().min(1).max(255),
  isPublic: z.boolean().optional()
});

const updateBoardSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  isPublic: z.boolean().optional(),
  settings: z.any().optional()
});

export class BoardController {
  async getBoards(req: Request, res: Response) {
    try {
      const userId = (req as any).userId;
      const boards = await boardService.getUserBoards(userId);
      res.json(boards);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.issues });
      }
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  }

  async getBoard(req: Request, res: Response) {
    try {
      const id = req.params.id as string;
      const userId = (req as any).userId;
      const board = await boardService.getBoard(id, userId);
      res.json(board);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(404).json({ error: message });
    }
  }

  async createBoard(req: Request, res: Response) {
    try {
      const userId = (req as any).userId;
      const { title, isPublic } = createBoardSchema.parse(req.body);
      const board = await boardService.createBoard(title, userId, isPublic);
      res.status(201).json(board);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.issues });
      }
      const message = error instanceof Error ? error.message : 'Something went wrong';
      res.status(400).json({ error: message });
    }
  }

  async updateBoard(req: Request, res: Response) {
    try {
      const id = req.params.id as string;
      const userId = (req as any).userId;
      const data = updateBoardSchema.parse(req.body);
      const board = await boardService.updateBoard(id, userId, data);
      res.json(board);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.issues });
      }
      const message = error instanceof Error ? error.message : 'Something went wrong';
      res.status(400).json({ error: message });
    }
  }

  async deleteBoard(req: Request, res: Response) {
    try {
      const id = req.params.id as string;
      const userId = (req as any).userId;
      await boardService.deleteBoard(id, userId);
      res.status(204).send();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(404).json({ error: message });
    }
  }
}
