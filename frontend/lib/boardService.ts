import api from './api';
import { Board, CreateBoardInput, UpdateBoardInput } from '@/types/board';
import { Element } from '@/types/element';

export const boardService = {
  async getBoards(): Promise<Board[]> {
    const response = await api.get('/api/boards');
    return response.data;
  },

  async getBoard(id: string): Promise<Board> {
    const response = await api.get(`/api/boards/${id}`);
    return response.data;
  },

  async createBoard(data: CreateBoardInput): Promise<Board> {
    const response = await api.post('/api/boards', data);
    return response.data;
  },

  async updateBoard(id: string, data: UpdateBoardInput): Promise<Board> {
    const response = await api.patch(`/api/boards/${id}`, data);
    return response.data;
  },

  async deleteBoard(id: string): Promise<void> {
    await api.delete(`/api/boards/${id}`);
  },

  async getBoardElements(boardId: string): Promise<Element[]> {
    const response = await api.get(`/api/boards/${boardId}/elements`);
    return response.data;
  },
};