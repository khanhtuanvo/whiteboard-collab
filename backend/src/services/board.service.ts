import prisma from '../config/database';
import { Role } from '@prisma/client';

export class BoardService {
    async getUserBoards(userId: string) {
        const boards = await prisma.board.findMany({
            where: {
                OR: [
                    { ownerId: userId },
                    {
                        collaborators: {
                            some: {userId}
                        }
                    }
                ]
            },
            orderBy: {updatedAt: 'desc'}
        });
        return boards;
    }

    async getBoard(boardId: string, userId: string){
        const board = await prisma.board.findFirst({
            where: {
                id: boardId,
                OR: [
                    { ownerId: userId},
                    { collaborators: {
                        some: { userId }
                    }},
                    {
                        isPublic: true
                    }
                ]
            },
            include: {
                owner: {
                    select: { id: true, name: true, email: true}
                }
            }
        });
        if (!board){
            throw new Error('Board not found or access denied')
        }
        return board;
    }

    async createBoard(title: string, ownerId: string, isPublic: boolean = false){
        const board = await prisma.board.create({
            data: {
                title,
                ownerId,
                isPublic
            }
        });
        return board;
    }

    async updateBoard(boardId: string, userId: string, data: any){
        const board = await prisma.board.findFirst({
            where: {
                id: boardId,
                OR: [
                    {ownerId: userId},
                    {
                        collaborators: {
                            some: {
                                userId,
                                role: { in: [Role.EDITOR, Role.ADMIN]}
                            }
                        }
                    }
                ]
            }
        });
        if (!board){
            throw new Error('Board not found or access denied');
        }
        const updatedBoard = await prisma.board.update({
            where: {
                id: boardId,
            },
            data,
        });
        return updatedBoard;
    }

    async getBoardElements(boardId: string, userId: string) {
        const board = await prisma.board.findFirst({
            where: {
                id: boardId,
                OR: [
                    { ownerId: userId },
                    { collaborators: { some: { userId } } },
                    { isPublic: true }
                ]
            }
        });
        if (!board) {
            throw new Error('Board not found or access denied');
        }
        return prisma.element.findMany({
            where: { boardId },
            orderBy: { zIndex: 'asc' }
        });
    }

    async addCollaborator(boardId: string, ownerId: string, email: string, role: Role = Role.EDITOR) {
        const board = await prisma.board.findFirst({
            where: { id: boardId, ownerId }
        });
        if (!board) {
            throw new Error('Board not found or only the owner can add collaborators');
        }

        const user = await prisma.user.findUnique({ where: { email } });
        if (!user) {
            throw new Error('User not found');
        }

        if (user.id === ownerId) {
            throw new Error('Owner is already a member of the board');
        }

        return prisma.boardCollaborator.upsert({
            where: { boardId_userId: { boardId, userId: user.id } },
            create: { boardId, userId: user.id, role },
            update: { role },
        });
    }

    async deleteBoard(boardId: string, userId:string){
        const board = await prisma.board.findFirst({
            where: {
                id: boardId,
                ownerId: userId
            }
        });
        if (!board){
            throw new Error("Board not found or access denied");
        }
        await prisma.board.delete({
            where: {id: boardId}
        });
    }

}