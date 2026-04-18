jest.mock('../../src/config/database', () => ({
  __esModule: true,
  default: {
    board: {
      findFirst: jest.fn(),
    },
    $queryRaw: jest.fn().mockResolvedValue([{ 1: 1 }]),
    $disconnect: jest.fn(),
  },
}));

jest.mock('../../src/config/redis', () => ({
  __esModule: true,
  default: {
    ping: jest.fn().mockResolvedValue('PONG'),
    get: jest.fn().mockResolvedValue(null),
    setex: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
  },
}));

import request from 'supertest';
import prisma from '../../src/config/database';
import { generateToken } from '../../src/utils/jwt';
import { createTestApp } from '../helpers/testApp';

describe('POST /api/boards/:id/ai/cluster', () => {
  const app = createTestApp();

  const USER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const BOARD_ID = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
  const authToken = generateToken(USER_ID);

  const notes = [
    { id: 'n1', text: 'auth flow', x: 10, y: 10, width: 200, height: 200 },
    { id: 'n2', text: 'session bug', x: 220, y: 40, width: 200, height: 200 },
    { id: 'n3', text: 'login UX', x: 420, y: 60, width: 200, height: 200 },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ML_SERVICE_URL = 'http://localhost:5000';
    process.env.ML_SERVICE_KEY = 'test-key';

    (prisma.board.findFirst as jest.Mock).mockResolvedValue({ id: BOARD_ID, ownerId: USER_ID });
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn();
  });

  it('forwards k override to ML service payload', async () => {
    (global as unknown as { fetch: jest.Mock }).fetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue([
        { id: 'n1', cluster: 0, suggestedX: 100, suggestedY: 100 },
        { id: 'n2', cluster: 0, suggestedX: 200, suggestedY: 200 },
        { id: 'n3', cluster: 1, suggestedX: 300, suggestedY: 300 },
      ]),
    });

    const res = await request(app)
      .post(`/api/boards/${BOARD_ID}/ai/cluster`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ notes, k: 2, options: { layoutMode: 'preserve' } });

    expect(res.status).toBe(200);
    expect(res.body.degraded).toBe(false);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    const [, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(init.body)).toMatchObject({
      notes,
      k: 2,
      options: { layoutMode: 'preserve' },
    });
  });

  it('returns degraded=true with fallback positions when ML service fails', async () => {
    (global as unknown as { fetch: jest.Mock }).fetch.mockRejectedValue(new Error('ml down'));

    const res = await request(app)
      .post(`/api/boards/${BOARD_ID}/ai/cluster`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ notes });

    expect(res.status).toBe(200);
    expect(res.body.degraded).toBe(true);
    expect(Array.isArray(res.body.results)).toBe(true);
    expect(res.body.results).toEqual([
      { id: 'n1', cluster: 0, suggestedX: 10, suggestedY: 10 },
      { id: 'n2', cluster: 0, suggestedX: 220, suggestedY: 40 },
      { id: 'n3', cluster: 0, suggestedX: 420, suggestedY: 60 },
    ]);
  });
});
