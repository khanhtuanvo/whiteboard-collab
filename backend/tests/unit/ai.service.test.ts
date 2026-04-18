jest.mock('../../src/config/database', () => ({
  __esModule: true,
  default: {
    board: {
      findFirst: jest.fn(),
    },
  },
}));

jest.mock('../../src/config/redis', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    setex: jest.fn(),
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

import prisma from '../../src/config/database';
import redis from '../../src/config/redis';
import { AiService, ClusterOptions } from '../../src/services/ai.service';

const BOARD_ID = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const USER_ID = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';

const ELEMENTS = [
  { id: '1', text: 'Design login screen', x: 100, y: 100 },
  { id: '2', text: 'Fix auth bug', x: 200, y: 120 },
];

const CLUSTER_RESULTS = [
  { id: '1', cluster: 0, suggestedX: 90, suggestedY: 110 },
  { id: '2', cluster: 0, suggestedX: 210, suggestedY: 130 },
];

const PRESERVE_OPTIONS: ClusterOptions = {
  layoutMode: 'preserve',
  alpha: 0.35,
  maxDisplacement: 400,
  noteWidth: 200,
  noteHeight: 200,
};

const K_OVERRIDE = 3;

describe('AiService.clusterElements', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ML_SERVICE_URL = 'http://localhost:5000';
    process.env.ML_SERVICE_KEY = 'test-key';

    (prisma.board.findFirst as jest.Mock).mockResolvedValue({ id: BOARD_ID, ownerId: USER_ID });
    (redis.get as jest.Mock).mockResolvedValue(null);
    (redis.setex as jest.Mock).mockResolvedValue('OK');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (redis as any).del = jest.fn().mockResolvedValue(1);

    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn();
  });

  it('sends cluster payload as { notes: elements } to the ML service', async () => {
    (global as unknown as { fetch: jest.Mock }).fetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue(CLUSTER_RESULTS),
    });

    const service = new AiService();
    const result = await service.clusterElements(BOARD_ID, USER_ID, ELEMENTS);

    expect(result).toEqual({
      results: CLUSTER_RESULTS,
      degraded: false,
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);

    const fetchCall = (global.fetch as jest.Mock).mock.calls[0];
    expect(fetchCall[0]).toBe('http://localhost:5000/cluster');

    const requestInit = fetchCall[1] as { method: string; body: string };
    expect(requestInit.method).toBe('POST');
    expect(JSON.parse(requestInit.body)).toEqual({ notes: ELEMENTS });
  });

  it('returns cached clustering results without calling the ML service', async () => {
    (redis.get as jest.Mock).mockResolvedValue(JSON.stringify(CLUSTER_RESULTS));

    const service = new AiService();
    const result = await service.clusterElements(BOARD_ID, USER_ID, ELEMENTS);

    expect(result).toEqual({
      results: CLUSTER_RESULTS,
      degraded: false,
    });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(redis.setex).not.toHaveBeenCalled();
  });

  it('forwards clustering options to the ML service payload', async () => {
    (global as unknown as { fetch: jest.Mock }).fetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue(CLUSTER_RESULTS),
    });

    const service = new AiService();
    await service.clusterElements(BOARD_ID, USER_ID, ELEMENTS, PRESERVE_OPTIONS);

    const fetchCall = (global.fetch as jest.Mock).mock.calls[0];
    const requestInit = fetchCall[1] as { body: string };
    expect(JSON.parse(requestInit.body)).toEqual({ notes: ELEMENTS, options: PRESERVE_OPTIONS });
  });

  it('forwards k override to the ML service payload', async () => {
    (global as unknown as { fetch: jest.Mock }).fetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue(CLUSTER_RESULTS),
    });

    const service = new AiService();
    await service.clusterElements(BOARD_ID, USER_ID, ELEMENTS, PRESERVE_OPTIONS, K_OVERRIDE);

    const fetchCall = (global.fetch as jest.Mock).mock.calls[0];
    const requestInit = fetchCall[1] as { body: string };
    expect(JSON.parse(requestInit.body)).toEqual({ notes: ELEMENTS, options: PRESERVE_OPTIONS, k: K_OVERRIDE });
  });

  it('evicts malformed cache and recomputes via ML service', async () => {
    (redis.get as jest.Mock).mockResolvedValue('not-json');
    (global as unknown as { fetch: jest.Mock }).fetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue(CLUSTER_RESULTS),
    });

    const service = new AiService();
    const result = await service.clusterElements(BOARD_ID, USER_ID, ELEMENTS);

    expect(result).toEqual({
      results: CLUSTER_RESULTS,
      degraded: false,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((redis as any).del).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(redis.setex).toHaveBeenCalledTimes(1);
  });

  it('does not reuse cache when only geometry changes', async () => {
    const firstResults = [{ id: '1', cluster: 0, suggestedX: 101, suggestedY: 101 }];
    const secondResults = [{ id: '1', cluster: 0, suggestedX: 555, suggestedY: 555 }];

    (global as unknown as { fetch: jest.Mock }).fetch
      .mockResolvedValueOnce({ ok: true, json: jest.fn().mockResolvedValue(firstResults) })
      .mockResolvedValueOnce({ ok: true, json: jest.fn().mockResolvedValue(secondResults) });

    let firstKey = '';
    (redis.setex as jest.Mock).mockImplementation(async (key: string, _ttl: number, value: string) => {
      if (!firstKey) firstKey = key;
      return value;
    });
    (redis.get as jest.Mock).mockImplementation(async (key: string) => {
      if (firstKey && key === firstKey) {
        return JSON.stringify(firstResults);
      }
      return null;
    });

    const service = new AiService();
    await service.clusterElements(BOARD_ID, USER_ID, ELEMENTS);

    const movedElements = ELEMENTS.map((element) => ({
      ...element,
      x: element.x + 800,
      y: element.y + 800,
    }));
    await service.clusterElements(BOARD_ID, USER_ID, movedElements);

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(redis.get).toHaveBeenCalledTimes(2);
    const [firstCacheLookup, secondCacheLookup] = (redis.get as jest.Mock).mock.calls.map((call) => call[0]);
    expect(firstCacheLookup).not.toEqual(secondCacheLookup);
  });

  it('falls back to original positions when ML request fails', async () => {
    (global as unknown as { fetch: jest.Mock }).fetch.mockRejectedValue(new Error('connection refused'));

    const service = new AiService();
    const result = await service.clusterElements(BOARD_ID, USER_ID, ELEMENTS);

    expect(result).toEqual({
      results: [
        { id: '1', cluster: 0, suggestedX: 100, suggestedY: 100 },
        { id: '2', cluster: 0, suggestedX: 200, suggestedY: 120 },
      ],
      degraded: true,
    });
    expect(redis.setex).not.toHaveBeenCalled();
  });
});
