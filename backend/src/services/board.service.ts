import prisma from '../config/database';
import { Role } from '@prisma/client';
import { Prisma } from '@prisma/client';
export class BoardService {
    async getUserBoards(userId: string, page: number = 1, limit: number = 20) {
        const skip = (page - 1) * limit;
        const where = {
            OR: [
                { ownerId: userId },
                { collaborators: { some: { userId } } }
            ]
        };
        const [boards, total] = await Promise.all([
            prisma.board.findMany({
                where,
                orderBy: { updatedAt: 'desc' },
                skip,
                take: limit,
                include: {
                    _count: { select: { collaborators: true } },
                    collaborators: {
                        where: { userId },
                        select: { role: true }
                    }
                }
            }),
            prisma.board.count({ where }),
        ]);
        const data = boards.map(b => ({
            ...b,
            userRole: b.ownerId === userId ? 'OWNER' : (b.collaborators[0]?.role ?? 'VIEWER'),
        }));
        return { data, total, page, pageSize: limit };
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
                },
                collaborators: {
                    where: { userId },
                    select: { role: true }
                }
            }
        });
        if (!board){
            throw new Error('Board not found or access denied')
        }
        const userRole = board.ownerId === userId ? 'OWNER' : (board.collaborators[0]?.role ?? 'VIEWER');
        return { ...board, userRole };
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

    async updateBoard(boardId: string, userId: string, data: Prisma.BoardUpdateInput){
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

    async getPublicBoard(boardId: string) {
        const board = await prisma.board.findFirst({
            where: { id: boardId, isPublic: true },
            include: {
                owner: { select: { id: true, name: true } },
            }
        });
        if (!board) throw new Error('Board not found or not public');
        return { ...board, userRole: 'VIEWER' as const };
    }

    async getPublicBoardElements(boardId: string) {
        const board = await prisma.board.findFirst({
            where: { id: boardId, isPublic: true }
        });
        if (!board) throw new Error('Board not found or not public');
        return prisma.element.findMany({
            where: { boardId },
            orderBy: { zIndex: 'asc' }
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