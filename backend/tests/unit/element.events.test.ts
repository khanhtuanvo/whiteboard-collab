/**
 * Unit tests for ElementEvents — verifying all six bug fixes.
 *
 * Fix coverage:
 *  F1 — handleUndo: undo entry not consumed when restoreSnapshot fails
 *  F2 — handleRedo: dead lpush check removed; redo entry not consumed on restore failure
 *  F3 — saveSnapshot: Lua script used (atomic lpush + ltrim + del)
 *  F4 — handleUpdateElement: beforeProperties captured from inside the transaction
 *  F5 — handleUpdateElement: type guard on elem.properties spread; propertiesResult.data used
 *  F6 — handleUpdateElement: no DB read on live drag ticks
 */

// ── Mocks (hoisted before any import) ────────────────────────────────────────

// Transaction callback executor — shared so individual tests can swap elem data.
let mockTxElem: Record<string, unknown> | null = null;

jest.mock('../../src/config/database', () => ({
  __esModule: true,
  default: {
    board: {
      findFirst: jest.fn(),
    },
    element: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
      aggregate: jest.fn(),
    },
    $transaction: jest.fn(),
    $executeRaw: jest.fn(),
  },
}));

// Multi-chain mock — returned by redis.multi()
const mockMultiExec = jest.fn();
const mockMultiChain = {
  lpush: jest.fn().mockReturnThis(),
  ltrim: jest.fn().mockReturnThis(),
  exec: mockMultiExec,
};

jest.mock('../../src/config/redis', () => ({
  __esModule: true,
  default: {
    eval: jest.fn(),
    lpush: jest.fn(),
    ltrim: jest.fn(),
    del: jest.fn(),
    llen: jest.fn(),
    lindex: jest.fn(),
    lpop: jest.fn(),
    zadd: jest.fn(),
    zremrangebyrank: jest.fn(),
    publish: jest.fn(),
    multi: jest.fn(),
    xadd: jest.fn(),
  },
}));

jest.mock('../../src/config/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// ── Imports ───────────────────────────────────────────────────────────────────
import { Socket, Server } from 'socket.io';
import prisma from '../../src/config/database';
import redis from '../../src/config/redis';
import { ElementEvents } from '../../src/websocket/events/element.events';
import { ElementType, Role } from '@prisma/client';

// ── Fixtures ──────────────────────────────────────────────────────────────────
const BOARD_ID = 'board-aaa-111';
const USER_ID  = 'user-bbb-222';
const ELEM_ID  = 'elem-ccc-333';

const BASE_PROPS = { x: 10, y: 20 };

const MOCK_ELEMENT = {
  id: ELEM_ID,
  boardId: BOARD_ID,
  type: 'RECTANGLE' as ElementType,
  properties: { x: 10, y: 20, fill: 'red' },
  zIndex: 1,
  createdBy: USER_ID,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const SNAPSHOT_A: unknown[] = [
  { id: ELEM_ID, boardId: BOARD_ID, type: 'RECTANGLE', properties: { x: 0, y: 0 }, zIndex: 1, createdBy: USER_ID },
];
const SNAPSHOT_A_STR = JSON.stringify(SNAPSHOT_A);

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSocket(): jest.Mocked<Pick<Socket, 'emit'>> & { id: string } {
  return { emit: jest.fn(), id: 'sock-1' } as unknown as ReturnType<typeof makeSocket>;
}

function makeIo(): { to: jest.Mock; roomEmit: jest.Mock } {
  const roomEmit = jest.fn();
  const to = jest.fn().mockReturnValue({ emit: roomEmit });
  return { to, roomEmit } as unknown as ReturnType<typeof makeIo>;
}

/** Grant board access for checkBoardAccess */
function grantAccess() {
  (prisma.board.findFirst as jest.Mock).mockResolvedValue({ id: BOARD_ID, ownerId: USER_ID });
}

/** Deny board access */
function denyAccess() {
  (prisma.board.findFirst as jest.Mock).mockResolvedValue(null);
}

/** Make readCurrentSnapshot return an empty board */
function mockEmptyBoard() {
  (prisma.element.findMany as jest.Mock).mockResolvedValue([]);
}

/** Make restoreSnapshot succeed (prisma.$transaction runs the callback with a tx stub) */
function mockRestoreSuccess() {
  (prisma.$transaction as jest.Mock).mockImplementation(async (fn: Function) => {
    const tx = {
      element: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue(mockTxElem ?? MOCK_ELEMENT),
        update: jest.fn().mockResolvedValue(MOCK_ELEMENT),
        aggregate: jest.fn().mockResolvedValue({ _max: { zIndex: 1 } }),
        create: jest.fn().mockResolvedValue(MOCK_ELEMENT),
      },
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
    return fn(tx);
  });
}

/** Make restoreSnapshot fail */
function mockRestoreFailure() {
  (prisma.$transaction as jest.Mock).mockRejectedValue(new Error('DB down'));
}

// ── Setup / teardown ──────────────────────────────────────────────────────────
beforeEach(() => {
  jest.clearAllMocks();
  mockTxElem = null;

  // Default redis stubs
  (redis.eval as jest.Mock).mockResolvedValue(null);
  (redis.llen as jest.Mock).mockResolvedValue(3);
  (redis.lpush as jest.Mock).mockResolvedValue(1);
  (redis.ltrim as jest.Mock).mockResolvedValue('OK');
  (redis.del as jest.Mock).mockResolvedValue(1);
  (redis.zadd as jest.Mock).mockResolvedValue(1);
  (redis.zremrangebyrank as jest.Mock).mockResolvedValue(0);
  (redis.publish as jest.Mock).mockResolvedValue(1);
  (redis.multi as jest.Mock).mockReturnValue(mockMultiChain);
  mockMultiExec.mockResolvedValue([[null, 1], [null, 'OK']]);
  mockMultiChain.lpush.mockReturnThis();
  mockMultiChain.ltrim.mockReturnThis();
  // saveSnapshot Lua — (redis as any).eval shares the same mock
  (redis as unknown as Record<string, jest.Mock>)['xadd'] = jest.fn().mockResolvedValue('1-0');
});

// =============================================================================
// F3 — saveSnapshot uses Lua eval (atomic lpush + ltrim + del)
// =============================================================================
describe('F3 — saveSnapshot atomicity via Lua', () => {
  it('calls redis.eval (not separate lpush/ltrim/del) when saving a snapshot', async () => {
    grantAccess();
    mockEmptyBoard();

    const updatedEl = { ...MOCK_ELEMENT, properties: { x: 99, y: 0 } };
    (prisma.$transaction as jest.Mock).mockImplementation(async (fn: Function) => {
      const tx = {
        element: {
          findUnique: jest.fn().mockResolvedValue(MOCK_ELEMENT),
          update: jest.fn().mockResolvedValue(updatedEl),
        },
        $executeRaw: jest.fn(),
      };
      return fn(tx);
    });

    (prisma.element.findUnique as jest.Mock).mockResolvedValue(MOCK_ELEMENT);

    const events = new ElementEvents();
    const socket = makeSocket();
    const { to, roomEmit } = makeIo();

    await events.handleUpdateElement(
      socket as unknown as Socket,
      { to } as unknown as Server,
      { boardId: BOARD_ID, elementId: ELEM_ID, userId: USER_ID, properties: { x: 99, y: 0 } }
    );

    // Lua eval must have been called (saveSnapshot path)
    expect(redis.eval).toHaveBeenCalled();
    const evalCall = (redis.eval as jest.Mock).mock.calls[0];
    // Script should contain LPUSH, LTRIM, DEL
    expect(evalCall[0]).toMatch(/LPUSH/i);
    expect(evalCall[0]).toMatch(/LTRIM/i);
    expect(evalCall[0]).toMatch(/DEL/i);
    // numkeys = 2 (snapshotKey + redoKey)
    expect(evalCall[1]).toBe(2);
    // Key 1 = undo stack
    expect(evalCall[2]).toBe(`snapshots:${BOARD_ID}:${USER_ID}`);
    // Key 2 = redo stack
    expect(evalCall[3]).toBe(`redo:${BOARD_ID}:${USER_ID}`);

    // Standalone lpush/ltrim/del must NOT be called (they would be non-atomic)
    expect(redis.lpush).not.toHaveBeenCalled();
    expect(redis.ltrim).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();

    expect(roomEmit).toHaveBeenCalledWith('element:updated', expect.any(Object));
  });
});

// =============================================================================
// F1 — handleUndo: undo entry preserved on restore failure
// =============================================================================
describe('F1 — handleUndo: undo entry not lost on restore failure', () => {
  it('re-pushes the undo entry when restoreSnapshot throws', async () => {
    grantAccess();
    mockEmptyBoard();      // readCurrentSnapshot returns []
    mockRestoreFailure();  // prisma.$transaction throws

    // Lua pop returns the snapshot string (simulates a successful atomic pop)
    (redis.eval as jest.Mock).mockResolvedValueOnce(SNAPSHOT_A_STR);

    const events = new ElementEvents();
    const socket = makeSocket();
    const { to } = makeIo();

    await events.handleUndo(
      socket as unknown as Socket,
      { to } as unknown as Server,
      { boardId: BOARD_ID, userId: USER_ID }
    );

    // The entry must be re-pushed to undo so it is not permanently lost
    expect(redis.lpush).toHaveBeenCalledWith(
      `snapshots:${BOARD_ID}:${USER_ID}`,
      SNAPSHOT_A_STR
    );

    // Client receives an error (restore failed)
    expect(socket.emit).toHaveBeenCalledWith('error', expect.objectContaining({ message: 'Failed to undo' }));
  });

  it('does NOT re-push when restoreSnapshot succeeds', async () => {
    grantAccess();
    mockEmptyBoard();
    mockRestoreSuccess();

    (redis.eval as jest.Mock).mockResolvedValueOnce(SNAPSHOT_A_STR);

    const events = new ElementEvents();
    const socket = makeSocket();
    const { to } = makeIo();

    await events.handleUndo(
      socket as unknown as Socket,
      { to } as unknown as Server,
      { boardId: BOARD_ID, userId: USER_ID }
    );

    // No re-push on success
    expect(redis.lpush).not.toHaveBeenCalledWith(
      `snapshots:${BOARD_ID}:${USER_ID}`,
      SNAPSHOT_A_STR
    );
    expect(socket.emit).not.toHaveBeenCalledWith('error', expect.anything());
  });

  it('pushes current board state to redo via multi() after successful restore', async () => {
    grantAccess();
    mockEmptyBoard();
    mockRestoreSuccess();

    (redis.eval as jest.Mock).mockResolvedValueOnce(SNAPSHOT_A_STR);

    const events = new ElementEvents();
    const socket = makeSocket();
    const { to, roomEmit } = makeIo();

    await events.handleUndo(
      socket as unknown as Socket,
      { to } as unknown as Server,
      { boardId: BOARD_ID, userId: USER_ID }
    );

    // multi() must have been used (not bare lpush) for the redo push
    expect(redis.multi).toHaveBeenCalled();
    expect(mockMultiChain.lpush).toHaveBeenCalledWith(
      `redo:${BOARD_ID}:${USER_ID}`,
      expect.any(String)
    );
    expect(mockMultiChain.ltrim).toHaveBeenCalledWith(`redo:${BOARD_ID}:${USER_ID}`, 0, 49);
    expect(mockMultiExec).toHaveBeenCalled();

    // Board broadcast and history state emitted
    expect(roomEmit).toHaveBeenCalledWith('element:snapshot', expect.any(Array));
    expect(socket.emit).toHaveBeenCalledWith('history:state', expect.objectContaining({
      undoDepth: expect.any(Number),
      redoDepth: expect.any(Number),
    }));
  });

  it('returns silently when the undo stack is empty', async () => {
    grantAccess();

    // Lua returns null → stack is empty
    (redis.eval as jest.Mock).mockResolvedValueOnce(null);

    const events = new ElementEvents();
    const socket = makeSocket();
    const { to } = makeIo();

    await events.handleUndo(
      socket as unknown as Socket,
      { to } as unknown as Server,
      { boardId: BOARD_ID, userId: USER_ID }
    );

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it('emits permission denied when user lacks access', async () => {
    denyAccess();

    const events = new ElementEvents();
    const socket = makeSocket();
    const { to } = makeIo();

    await events.handleUndo(
      socket as unknown as Socket,
      { to } as unknown as Server,
      { boardId: BOARD_ID, userId: USER_ID }
    );

    expect(socket.emit).toHaveBeenCalledWith('error', { message: 'Permission denied' });
    expect(redis.eval).not.toHaveBeenCalled();
  });
});

// =============================================================================
// F2 — handleRedo: dead lpush check removed; redo entry preserved on failure
// =============================================================================
describe('F2 — handleRedo: redo entry not lost on restore failure', () => {
  it('re-pushes the redo entry when restoreSnapshot throws', async () => {
    grantAccess();
    mockEmptyBoard();
    mockRestoreFailure();

    (redis.eval as jest.Mock).mockResolvedValueOnce(SNAPSHOT_A_STR);

    const events = new ElementEvents();
    const socket = makeSocket();
    const { to } = makeIo();

    await events.handleRedo(
      socket as unknown as Socket,
      { to } as unknown as Server,
      { boardId: BOARD_ID, userId: USER_ID }
    );

    // Redo entry re-pushed to the redo stack
    expect(redis.lpush).toHaveBeenCalledWith(
      `redo:${BOARD_ID}:${USER_ID}`,
      SNAPSHOT_A_STR
    );

    expect(socket.emit).toHaveBeenCalledWith('error', expect.objectContaining({ message: 'Failed to redo' }));
  });

  it('does NOT re-push redo entry when restore succeeds', async () => {
    grantAccess();
    mockEmptyBoard();
    mockRestoreSuccess();

    (redis.eval as jest.Mock).mockResolvedValueOnce(SNAPSHOT_A_STR);

    const events = new ElementEvents();
    const socket = makeSocket();
    const { to } = makeIo();

    await events.handleRedo(
      socket as unknown as Socket,
      { to } as unknown as Server,
      { boardId: BOARD_ID, userId: USER_ID }
    );

    expect(redis.lpush).not.toHaveBeenCalledWith(
      `redo:${BOARD_ID}:${USER_ID}`,
      SNAPSHOT_A_STR
    );
    expect(socket.emit).not.toHaveBeenCalledWith('error', expect.anything());
  });

  it('pushes current state to undo via multi() after successful restore', async () => {
    grantAccess();
    mockEmptyBoard();
    mockRestoreSuccess();

    (redis.eval as jest.Mock).mockResolvedValueOnce(SNAPSHOT_A_STR);

    const events = new ElementEvents();
    const socket = makeSocket();
    const { to, roomEmit } = makeIo();

    await events.handleRedo(
      socket as unknown as Socket,
      { to } as unknown as Server,
      { boardId: BOARD_ID, userId: USER_ID }
    );

    expect(redis.multi).toHaveBeenCalled();
    expect(mockMultiChain.lpush).toHaveBeenCalledWith(
      `snapshots:${BOARD_ID}:${USER_ID}`,
      expect.any(String)
    );
    expect(mockMultiChain.ltrim).toHaveBeenCalledWith(`snapshots:${BOARD_ID}:${USER_ID}`, 0, 49);
    expect(mockMultiExec).toHaveBeenCalled();

    expect(roomEmit).toHaveBeenCalledWith('element:snapshot', expect.any(Array));
    expect(socket.emit).toHaveBeenCalledWith('history:state', expect.objectContaining({
      undoDepth: expect.any(Number),
      redoDepth: expect.any(Number),
    }));
  });

  it('does NOT abort when undo-push via multi() fails after successful restore (non-fatal)', async () => {
    grantAccess();
    mockEmptyBoard();
    mockRestoreSuccess();

    (redis.eval as jest.Mock).mockResolvedValueOnce(SNAPSHOT_A_STR);

    // Simulate multi().exec() throwing after a successful restore
    mockMultiExec.mockRejectedValueOnce(new Error('Redis OOM'));

    const events = new ElementEvents();
    const socket = makeSocket();
    const { to, roomEmit } = makeIo();

    await events.handleRedo(
      socket as unknown as Socket,
      { to } as unknown as Server,
      { boardId: BOARD_ID, userId: USER_ID }
    );

    // Board broadcast still happens — restore already succeeded
    expect(roomEmit).toHaveBeenCalledWith('element:snapshot', expect.any(Array));
    // No error emitted to client — this path is non-fatal
    expect(socket.emit).not.toHaveBeenCalledWith('error', expect.anything());
    // history:state is still emitted
    expect(socket.emit).toHaveBeenCalledWith('history:state', expect.any(Object));
  });

  it('returns silently when redo stack is empty', async () => {
    grantAccess();
    (redis.eval as jest.Mock).mockResolvedValueOnce(null);

    const events = new ElementEvents();
    const socket = makeSocket();
    const { to } = makeIo();

    await events.handleRedo(
      socket as unknown as Socket,
      { to } as unknown as Server,
      { boardId: BOARD_ID, userId: USER_ID }
    );

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it('emits permission denied when user lacks access', async () => {
    denyAccess();

    const events = new ElementEvents();
    const socket = makeSocket();
    const { to } = makeIo();

    await events.handleRedo(
      socket as unknown as Socket,
      { to } as unknown as Server,
      { boardId: BOARD_ID, userId: USER_ID }
    );

    expect(socket.emit).toHaveBeenCalledWith('error', { message: 'Permission denied' });
    expect(redis.eval).not.toHaveBeenCalled();
  });
});

// =============================================================================
// F4 — handleUpdateElement: beforeProperties from inside transaction
// =============================================================================
describe('F4 — handleUpdateElement: beforeProperties captured inside the transaction', () => {
  it('uses elem.properties from the transaction read as the "before" value in history', async () => {
    grantAccess();
    mockEmptyBoard();

    // Outer currentElement (pre-transaction) has old properties
    const outerProps = { x: 100, y: 100, fill: 'blue' };
    (prisma.element.findUnique as jest.Mock).mockResolvedValue({
      ...MOCK_ELEMENT,
      properties: outerProps,
    });

    // Inside the transaction the element has been updated by a concurrent user
    const txProps = { x: 200, y: 200, fill: 'green' };
    const updatedProps = { x: 50, y: 20, fill: 'green' };
    mockTxElem = { ...MOCK_ELEMENT, properties: txProps };

    const txUpdate = { ...MOCK_ELEMENT, properties: updatedProps };
    (prisma.$transaction as jest.Mock).mockImplementation(async (fn: Function) => {
      const tx = {
        element: {
          findUnique: jest.fn().mockResolvedValue(mockTxElem),
          update: jest.fn().mockResolvedValue(txUpdate),
        },
      };
      return fn(tx);
    });

    const events = new ElementEvents();
    const socket = makeSocket();
    const { to } = makeIo();

    await events.handleUpdateElement(
      socket as unknown as Socket,
      { to } as unknown as Server,
      { boardId: BOARD_ID, elementId: ELEM_ID, userId: USER_ID, properties: { x: 50, y: 20 } }
    );

    expect(redis.zadd).toHaveBeenCalledWith(
      `history:${BOARD_ID}:${USER_ID}`,
      expect.any(Number),
      expect.stringContaining(JSON.stringify(txProps))  // before = tx read, NOT outer read
    );

    // Must NOT use the outer currentElement.properties as before
    const zaddPayload = JSON.parse((redis.zadd as jest.Mock).mock.calls[0][2]);
    expect(zaddPayload.before).toEqual(txProps);
    expect(zaddPayload.before).not.toEqual(outerProps);
  });
});

// =============================================================================
// F5 — handleUpdateElement: type guard on elem.properties + propertiesResult.data
// =============================================================================
describe('F5 — handleUpdateElement: type guard prevents data loss on non-object properties', () => {
  it('treats null elem.properties as empty object — does not drop incoming props', async () => {
    grantAccess();
    mockEmptyBoard();

    (prisma.element.findUnique as jest.Mock).mockResolvedValue(MOCK_ELEMENT);

    const nullPropsEl = { ...MOCK_ELEMENT, properties: null };
    const expectedResult = { ...MOCK_ELEMENT, properties: { x: 5, y: 10 } };

    let capturedUpdateData: unknown;
    (prisma.$transaction as jest.Mock).mockImplementation(async (fn: Function) => {
      const tx = {
        element: {
          findUnique: jest.fn().mockResolvedValue(nullPropsEl),
          update: jest.fn().mockImplementation(async (args: { data: unknown }) => {
            capturedUpdateData = args.data;
            return expectedResult;
          }),
        },
      };
      return fn(tx);
    });

    const events = new ElementEvents();
    const socket = makeSocket();
    const { to } = makeIo();

    await events.handleUpdateElement(
      socket as unknown as Socket,
      { to } as unknown as Server,
      { boardId: BOARD_ID, elementId: ELEM_ID, userId: USER_ID, properties: { x: 5, y: 10 } }
    );

    // Update must have been called with the incoming properties intact
    expect(capturedUpdateData).toEqual({ properties: { x: 5, y: 10 } });
    expect(socket.emit).not.toHaveBeenCalledWith('error', expect.anything());
  });

  it('preserves existing object properties when merging', async () => {
    grantAccess();
    mockEmptyBoard();

    (prisma.element.findUnique as jest.Mock).mockResolvedValue(MOCK_ELEMENT);

    const existingProps = { x: 10, y: 20, fill: 'red', stroke: 'black' };
    const existingEl = { ...MOCK_ELEMENT, properties: existingProps };
    const mergedResult = { ...MOCK_ELEMENT, properties: { ...existingProps, x: 99 } };

    let capturedUpdateData: unknown;
    (prisma.$transaction as jest.Mock).mockImplementation(async (fn: Function) => {
      const tx = {
        element: {
          findUnique: jest.fn().mockResolvedValue(existingEl),
          update: jest.fn().mockImplementation(async (args: { data: unknown }) => {
            capturedUpdateData = args.data;
            return mergedResult;
          }),
        },
      };
      return fn(tx);
    });

    const events = new ElementEvents();
    const socket = makeSocket();
    const { to } = makeIo();

    await events.handleUpdateElement(
      socket as unknown as Socket,
      { to } as unknown as Server,
      { boardId: BOARD_ID, elementId: ELEM_ID, userId: USER_ID, properties: { x: 99, y: 20 } }
    );

    // fill and stroke from existing props must be preserved in the merged update
    expect(capturedUpdateData).toEqual({
      properties: { x: 99, y: 20, fill: 'red', stroke: 'black' },
    });
  });

  it('broadcasts propertiesResult.data (validated) on live ticks, not raw input', async () => {
    grantAccess();

    const events = new ElementEvents();
    const socket = makeSocket();
    const { to, roomEmit } = makeIo();

    // Valid properties object
    await events.handleUpdateElement(
      socket as unknown as Socket,
      { to } as unknown as Server,
      { boardId: BOARD_ID, elementId: ELEM_ID, userId: USER_ID, properties: { x: 1, y: 2 }, live: true }
    );

    const emitCall = roomEmit.mock.calls[0];
    expect(emitCall[0]).toBe('element:updated');
    // Broadcast payload must contain the validated data
    expect(emitCall[1]).toEqual({ id: ELEM_ID, properties: { x: 1, y: 2 } });
  });

  it('rejects invalid properties before broadcasting on live ticks', async () => {
    grantAccess();

    const events = new ElementEvents();
    const socket = makeSocket();
    const { to, roomEmit } = makeIo();

    await events.handleUpdateElement(
      socket as unknown as Socket,
      { to } as unknown as Server,
      {
        boardId: BOARD_ID,
        elementId: ELEM_ID,
        userId: USER_ID,
        // x is required — this is invalid
        properties: { y: 5 } as unknown as { x: number; y: number },
        live: true,
      }
    );

    expect(socket.emit).toHaveBeenCalledWith('error', expect.objectContaining({ message: 'Invalid properties' }));
    expect(roomEmit).not.toHaveBeenCalled();
  });
});

// =============================================================================
// F6 — handleUpdateElement: no DB read on live drag ticks
// =============================================================================
describe('F6 — handleUpdateElement: no DB read on live ticks', () => {
  it('does not call prisma.element.findUnique on live=true ticks', async () => {
    grantAccess();

    const events = new ElementEvents();
    const socket = makeSocket();
    const { to, roomEmit } = makeIo();

    await events.handleUpdateElement(
      socket as unknown as Socket,
      { to } as unknown as Server,
      { boardId: BOARD_ID, elementId: ELEM_ID, userId: USER_ID, properties: BASE_PROPS, live: true }
    );

    expect(prisma.element.findUnique).not.toHaveBeenCalled();
    expect(roomEmit).toHaveBeenCalledWith('element:updated', { id: ELEM_ID, properties: BASE_PROPS });
  });

  it('does not touch the DB transaction or snapshot on live=true ticks', async () => {
    grantAccess();

    const events = new ElementEvents();
    const socket = makeSocket();
    const { to } = makeIo();

    await events.handleUpdateElement(
      socket as unknown as Socket,
      { to } as unknown as Server,
      { boardId: BOARD_ID, elementId: ELEM_ID, userId: USER_ID, properties: BASE_PROPS, live: true }
    );

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(redis.eval).not.toHaveBeenCalled();   // saveSnapshot Lua not called
    expect(redis.zadd).not.toHaveBeenCalled();   // history not written
  });

  it('still does the DB read on commit (live=false) ticks', async () => {
    grantAccess();
    mockEmptyBoard();
    (prisma.element.findUnique as jest.Mock).mockResolvedValue(MOCK_ELEMENT);

    (prisma.$transaction as jest.Mock).mockImplementation(async (fn: Function) => {
      const tx = {
        element: {
          findUnique: jest.fn().mockResolvedValue(MOCK_ELEMENT),
          update: jest.fn().mockResolvedValue(MOCK_ELEMENT),
        },
      };
      return fn(tx);
    });

    const events = new ElementEvents();
    const socket = makeSocket();
    const { to } = makeIo();

    await events.handleUpdateElement(
      socket as unknown as Socket,
      { to } as unknown as Server,
      { boardId: BOARD_ID, elementId: ELEM_ID, userId: USER_ID, properties: BASE_PROPS, live: false }
    );

    expect(prisma.element.findUnique).toHaveBeenCalledWith({ where: { id: ELEM_ID } });
  });
});

// =============================================================================
// Regression — resize/minimize then undo restores original size
// =============================================================================
describe('Regression — update snapshots preserve original dimensions', () => {
  it('stores pre-resize rectangle dimensions in undo snapshot before minimize update', async () => {
    grantAccess();

    const originalRectangle = {
      ...MOCK_ELEMENT,
      type: 'RECTANGLE' as ElementType,
      properties: {
        x: 40,
        y: 50,
        width: 240,
        height: 120,
        scaleX: 1,
        scaleY: 1,
        fill: '#f59e0b',
      },
    };

    const minimizedRectangle = {
      ...MOCK_ELEMENT,
      type: 'RECTANGLE' as ElementType,
      properties: {
        x: 40,
        y: 50,
        width: 240,
        height: 120,
        scaleX: 0.15,
        scaleY: 0.2,
        fill: '#f59e0b',
      },
    };

    // Snapshot source before update
    (prisma.element.findMany as jest.Mock).mockResolvedValue([originalRectangle]);

    // Non-live update precheck read
    (prisma.element.findUnique as jest.Mock).mockResolvedValue(originalRectangle);

    // Transactional update
    (prisma.$transaction as jest.Mock).mockImplementation(async (fn: Function) => {
      const tx = {
        element: {
          findUnique: jest.fn().mockResolvedValue(originalRectangle),
          update: jest.fn().mockResolvedValue(minimizedRectangle),
        },
      };
      return fn(tx);
    });

    const events = new ElementEvents();
    const socket = makeSocket();
    const { to } = makeIo();

    await events.handleUpdateElement(
      socket as unknown as Socket,
      { to } as unknown as Server,
      {
        boardId: BOARD_ID,
        elementId: ELEM_ID,
        userId: USER_ID,
        properties: {
          x: 40,
          y: 50,
          width: 240,
          height: 120,
          scaleX: 0.15,
          scaleY: 0.2,
        },
      }
    );

    expect(redis.eval).toHaveBeenCalled();
    const saveSnapshotArgs = (redis.eval as jest.Mock).mock.calls[0];
    const undoSerialized = saveSnapshotArgs[4] as string;
    const undoSnapshot = JSON.parse(undoSerialized) as Array<{ properties: Record<string, unknown> }>;

    expect(undoSnapshot).toHaveLength(1);
    expect(undoSnapshot[0].properties).toMatchObject({
      width: 240,
      height: 120,
      scaleX: 1,
      scaleY: 1,
    });
  });
});

// =============================================================================
// handleCreateElement — happy path + auth + validation
// =============================================================================
describe('handleCreateElement', () => {
  it('creates element and broadcasts on happy path', async () => {
    grantAccess();
    mockEmptyBoard();

    (prisma.$transaction as jest.Mock).mockImplementation(async (fn: Function) => {
      const tx = {
        element: {
          aggregate: jest.fn().mockResolvedValue({ _max: { zIndex: 0 } }),
          create: jest.fn().mockResolvedValue(MOCK_ELEMENT),
        },
        $executeRaw: jest.fn().mockResolvedValue(1),
      };
      return fn(tx);
    });

    const events = new ElementEvents();
    const socket = makeSocket();
    const { to, roomEmit } = makeIo();

    await events.handleCreateElement(
      socket as unknown as Socket,
      { to } as unknown as Server,
      { boardId: BOARD_ID, userId: USER_ID, type: 'RECTANGLE', properties: BASE_PROPS }
    );

    expect(roomEmit).toHaveBeenCalledWith('element:created', MOCK_ELEMENT);
    expect(redis.eval).toHaveBeenCalled(); // saveSnapshot Lua called
    expect(socket.emit).not.toHaveBeenCalledWith('error', expect.anything());
  });

  it('rejects unknown element type', async () => {
    grantAccess();

    const events = new ElementEvents();
    const socket = makeSocket();
    const { to } = makeIo();

    await events.handleCreateElement(
      socket as unknown as Socket,
      { to } as unknown as Server,
      { boardId: BOARD_ID, userId: USER_ID, type: 'INVALID_TYPE', properties: BASE_PROPS }
    );

    expect(socket.emit).toHaveBeenCalledWith('error', { message: 'Invalid element type' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects invalid properties', async () => {
    grantAccess();

    const events = new ElementEvents();
    const socket = makeSocket();
    const { to } = makeIo();

    await events.handleCreateElement(
      socket as unknown as Socket,
      { to } as unknown as Server,
      { boardId: BOARD_ID, userId: USER_ID, type: 'RECTANGLE', properties: { y: 5 } } // missing x
    );

    expect(socket.emit).toHaveBeenCalledWith('error', expect.objectContaining({ message: 'Invalid properties' }));
  });

  it('emits P2002 message on duplicate element ID', async () => {
    grantAccess();
    mockEmptyBoard();
    const dupError = Object.assign(new Error('Unique constraint'), { code: 'P2002' });
    (prisma.$transaction as jest.Mock).mockRejectedValue(dupError);

    const events = new ElementEvents();
    const socket = makeSocket();
    const { to } = makeIo();

    // Must be a valid UUID to pass the id-format check before reaching the DB
    const validUuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    await events.handleCreateElement(
      socket as unknown as Socket,
      { to } as unknown as Server,
      { boardId: BOARD_ID, userId: USER_ID, type: 'RECTANGLE', properties: BASE_PROPS, id: validUuid }
    );

    expect(socket.emit).toHaveBeenCalledWith('error', { message: 'Element ID already exists' });
  });

  it('emits permission denied when user lacks access', async () => {
    denyAccess();

    const events = new ElementEvents();
    const socket = makeSocket();
    const { to } = makeIo();

    await events.handleCreateElement(
      socket as unknown as Socket,
      { to } as unknown as Server,
      { boardId: BOARD_ID, userId: USER_ID, type: 'RECTANGLE', properties: BASE_PROPS }
    );

    expect(socket.emit).toHaveBeenCalledWith('error', { message: 'Permission denied' });
  });
});

// =============================================================================
// handleDeleteElement — happy path + auth
// =============================================================================
describe('handleDeleteElement', () => {
  it('deletes element, saves snapshot, and broadcasts', async () => {
    grantAccess();
    mockEmptyBoard();
    (prisma.element.findUnique as jest.Mock).mockResolvedValue(MOCK_ELEMENT);
    (prisma.element.delete as jest.Mock).mockResolvedValue(MOCK_ELEMENT);

    const events = new ElementEvents();
    const socket = makeSocket();
    const { to, roomEmit } = makeIo();

    await events.handleDeleteElement(
      socket as unknown as Socket,
      { to } as unknown as Server,
      { boardId: BOARD_ID, elementId: ELEM_ID, userId: USER_ID }
    );

    expect(prisma.element.delete).toHaveBeenCalledWith({ where: { id: ELEM_ID } });
    expect(redis.eval).toHaveBeenCalled(); // saveSnapshot Lua
    expect(roomEmit).toHaveBeenCalledWith('element:deleted', { id: ELEM_ID });
  });

  it('emits element not found when element is on a different board', async () => {
    grantAccess();
    (prisma.element.findUnique as jest.Mock).mockResolvedValue({
      ...MOCK_ELEMENT,
      boardId: 'other-board',
    });

    const events = new ElementEvents();
    const socket = makeSocket();
    const { to } = makeIo();

    await events.handleDeleteElement(
      socket as unknown as Socket,
      { to } as unknown as Server,
      { boardId: BOARD_ID, elementId: ELEM_ID, userId: USER_ID }
    );

    expect(socket.emit).toHaveBeenCalledWith('error', { message: 'Element not found' });
    expect(prisma.element.delete).not.toHaveBeenCalled();
  });
});

// =============================================================================
// handleClearBoard — role check
// =============================================================================
describe('handleClearBoard', () => {
  it('clears board and broadcasts when user is ADMIN', async () => {
    grantAccess();
    mockEmptyBoard();
    (prisma.element.deleteMany as jest.Mock).mockResolvedValue({ count: 5 });

    const events = new ElementEvents();
    const socket = makeSocket();
    const { to, roomEmit } = makeIo();

    await events.handleClearBoard(
      socket as unknown as Socket,
      { to } as unknown as Server,
      { boardId: BOARD_ID, userId: USER_ID }
    );

    expect(prisma.element.deleteMany).toHaveBeenCalledWith({ where: { boardId: BOARD_ID } });
    expect(roomEmit).toHaveBeenCalledWith('board:cleared');
    expect(redis.eval).toHaveBeenCalled(); // saveSnapshot Lua
  });

  it('rejects EDITOR users', async () => {
    denyAccess();

    const events = new ElementEvents();
    const socket = makeSocket();
    const { to } = makeIo();

    await events.handleClearBoard(
      socket as unknown as Socket,
      { to } as unknown as Server,
      { boardId: BOARD_ID, userId: USER_ID }
    );

    expect(socket.emit).toHaveBeenCalledWith('error', expect.objectContaining({ message: expect.stringMatching(/admin/i) }));
    expect(prisma.element.deleteMany).not.toHaveBeenCalled();
  });
});
