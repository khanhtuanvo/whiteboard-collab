/**
 * Unit tests for BoardService.getBoardElements
 *
 * Strategy: mock Prisma at the module level so no real DB is needed.
 * jest.mock is hoisted before any import, so BoardService receives the mock
 * when it imports prisma from '../../src/config/database'.
 */

// ── Mocks (hoisted before imports) ──────────────────────────────────────────
jest.mock('../../src/config/database', () => ({
  __esModule: true,
  default: {
    board: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    element: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    $queryRaw: jest.fn(),
    $disconnect: jest.fn(),
  },
}));

// Redis is imported transitively; stub it to avoid connection errors
jest.mock('../../src/config/redis', () => ({
  __esModule: true,
  default: {
    ping: jest.fn().mockResolvedValue('PONG'),
    disconnect: jest.fn(),
  },
}));

// ── Imports ──────────────────────────────────────────────────────────────────
import prisma from '../../src/config/database';
import { BoardService } from '../../src/services/board.service';

// ── Fixtures ─────────────────────────────────────────────────────────────────
const BOARD_ID = 'board-abc-123';
const OWNER_ID = 'user-owner-456';
const COLLAB_ID = 'user-collab-789';

const mockBoard = {
  id: BOARD_ID,
  title: 'Design Sprint',
  ownerId: OWNER_ID,
  isPublic: false,
  thumbnailUrl: null,
  settings: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockElements = [
  {
    id: 'elem-1',
    boardId: BOARD_ID,
    type: 'RECTANGLE',
    properties: { x: 10, y: 20, width: 100, height: 50, fill: '#3b82f6' },
    zIndex: 0,
    createdBy: OWNER_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: 'elem-2',
    boardId: BOARD_ID,
    type: 'STICKY_NOTE',
    properties: { x: 200, y: 300, width: 200, height: 200, text: 'Idea', color: '#fef08a' },
    zIndex: 1,
    createdBy: OWNER_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];

// ── Tests ────────────────────────────────────────────────────────────────────
describe('BoardService.getBoardElements', () => {
  let boardService: BoardService;

  beforeEach(() => {
    boardService = new BoardService();
  });

  it('returns elements ordered by zIndex when user is the board owner', async () => {
    (prisma.board.findFirst as jest.Mock).mockResolvedValue(mockBoard);
    (prisma.element.findMany as jest.Mock).mockResolvedValue(mockElements);

    const result = await boardService.getBoardElements(BOARD_ID, OWNER_ID);

    expect(result).toEqual(mockElements);
    expect(prisma.board.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: BOARD_ID }) })
    );
    expect(prisma.element.findMany).toHaveBeenCalledWith({
      where: { boardId: BOARD_ID },
      orderBy: { zIndex: 'asc' },
    });
  });

  it('returns elements when user is a collaborator on a private board', async () => {
    // Board owned by someone else; access is granted via collaborator check in Prisma OR clause
    const otherUserBoard = { ...mockBoard, ownerId: 'some-other-user' };
    (prisma.board.findFirst as jest.Mock).mockResolvedValue(otherUserBoard);
    (prisma.element.findMany as jest.Mock).mockResolvedValue(mockElements);

    const result = await boardService.getBoardElements(BOARD_ID, COLLAB_ID);

    expect(result).toEqual(mockElements);
    expect(prisma.element.findMany).toHaveBeenCalled();
  });

  it('returns elements when the board is public (any authenticated user)', async () => {
    const publicBoard = { ...mockBoard, ownerId: 'someone-else', isPublic: true };
    (prisma.board.findFirst as jest.Mock).mockResolvedValue(publicBoard);
    (prisma.element.findMany as jest.Mock).mockResolvedValue(mockElements);

    const result = await boardService.getBoardElements(BOARD_ID, 'random-user-id');

    expect(result).toEqual(mockElements);
  });

  it('throws "Board not found or access denied" when user has no access', async () => {
    (prisma.board.findFirst as jest.Mock).mockResolvedValue(null);

    await expect(
      boardService.getBoardElements(BOARD_ID, 'unauthorized-user')
    ).rejects.toThrow('Board not found or access denied');

    // Should never reach the elements query
    expect(prisma.element.findMany).not.toHaveBeenCalled();
  });
});
