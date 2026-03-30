import { Request, Response } from 'express';
import { BoardService } from '../services/board.service';
import { z } from 'zod';
import { Prisma } from '@prisma/client';

const boardService = new BoardService();

const createBoardSchema = z.object({
  title: z.string().min(1).max(255),
  isPublic: z.boolean().optional()
});

const addCollaboratorSchema = z.object({
  email: z.string().email(),
  role: z.enum(['VIEWER', 'EDITOR', 'ADMIN']).optional()
});

const updateBoardSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  isPublic: z.boolean().optional(),
  settings: z.record(z.string(), z.unknown()).optional()
});

export class BoardController {
  async getBoards(req: Request, res: Response) {
    try {
      const userId = req.userId!;
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
      const result = await boardService.getUserBoards(userId, page, limit);
      res.json(result);
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
      const userId = req.userId!;
      const board = await boardService.getBoard(id, userId);
      res.json(board);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(404).json({ error: message });
    }
  }

  async createBoard(req: Request, res: Response) {
    try {
      const userId = req.userId!;
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
      const userId = req.userId!;
      const data = updateBoardSchema.parse(req.body);
      const prismaData: Prisma.BoardUpdateInput = {
        ...data,
        settings: data.settings as Prisma.InputJsonValue
      };
      const board = await boardService.updateBoard(id, userId, prismaData);
    res.json(board);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.issues });
      }
      const message = error instanceof Error ? error.message : 'Something went wrong';
      res.status(400).json({ error: message });
    }
  }

  async getBoardElements(req: Request, res: Response) {
    try {
      const id = req.params.id as string;
      const userId = req.userId!;
      const elements = await boardService.getBoardElements(id, userId);
      res.json(elements);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(404).json({ error: message });
    }
  }

  async addCollaborator(req: Request, res: Response) {
    try {
      const boardId = req.params.id as string;
      const ownerId = req.userId!;
      const { email, role } = addCollaboratorSchema.parse(req.body);
      const collaborator = await boardService.addCollaborator(boardId, ownerId, email, role);
      res.status(201).json(collaborator);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.issues });
      }
      const message = error instanceof Error ? error.message : 'Something went wrong';
      res.status(400).json({ error: message });
    }
  }

  async getPublicBoard(req: Request, res: Response) {
    try {
      const id = req.params.id as string;
      const board = await boardService.getPublicBoard(id);
      res.json(board);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(404).json({ error: message });
    }
  }

  async getPublicBoardElements(req: Request, res: Response) {
    try {
      const id = req.params.id as string;
      const elements = await boardService.getPublicBoardElements(id);
      res.json(elements);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(404).json({ error: message });
    }
  }

  async deleteBoard(req: Request, res: Response) {
    try {
      const id = req.params.id as string;
      const userId = req.userId!;
      await boardService.deleteBoard(id, userId);
      res.status(204).send();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(404).json({ error: message });
    }
  }
}
