import { RedisThrottlerStorageService } from './redis-throttler-storage.service';

describe('RedisThrottlerStorageService', () => {
  const createExecChain = (results: Array<[Error | null, unknown]>) => {
    const chain = {
      incr: jest.fn().mockReturnThis(),
      pttl: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(results),
    };
    return chain;
  };

  const createService = (options?: {
    execResults?: Array<[Error | null, unknown]>;
    pttlValues?: number[];
    throwOnExec?: boolean;
  }) => {
    const execResults = options?.execResults ?? [
      [null, 1],
      [null, -1],
      [null, -2],
    ];
    const pttlValues = options?.pttlValues ?? [];
    const multi = options?.throwOnExec
      ? {
          incr: jest.fn().mockReturnThis(),
          pttl: jest.fn().mockReturnThis(),
          exec: jest.fn().mockRejectedValue(new Error('redis down')),
        }
      : createExecChain(execResults);

    const client = {
      multi: jest.fn(() => multi),
      pexpire: jest.fn().mockResolvedValue(1),
      set: jest.fn().mockResolvedValue('OK'),
      pttl: jest
        .fn()
        .mockImplementation(() => Promise.resolve(pttlValues.shift() ?? -2)),
    };
    const redisClientService = {
      createClient: jest.fn(() => client),
      releaseClient: jest.fn().mockResolvedValue(undefined),
    };

    const service = new RedisThrottlerStorageService(redisClientService as any);
    return { service, client, multi, redisClientService };
  };

  it('increments hits in redis and applies initial ttl', async () => {
    const { service, client } = createService();

    const result = await service.increment('key', 60_000, 5, 60_000, 'default');

    expect(result).toEqual({
      totalHits: 1,
      timeToExpire: 60,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
    expect(client.pexpire).toHaveBeenCalledWith(
      'throttler:default:key:count',
      60_000,
    );
  });

  it('blocks requests that exceed the limit', async () => {
    const { service, client } = createService({
      execResults: [
        [null, 6],
        [null, 45_000],
        [null, -2],
      ],
      pttlValues: [60_000],
    });

    const result = await service.increment('key', 60_000, 5, 60_000, 'default');

    expect(client.set).toHaveBeenCalledWith(
      'throttler:default:key:block',
      '1',
      'PX',
      60_000,
      'NX',
    );
    expect(result).toEqual({
      totalHits: 6,
      timeToExpire: 45,
      isBlocked: true,
      timeToBlockExpire: 60,
    });
  });

  it('falls back to in-memory throttling when redis errors', async () => {
    const { service } = createService({ throwOnExec: true });

    const first = await service.increment('key', 60_000, 5, 60_000, 'default');
    const second = await service.increment('key', 60_000, 5, 60_000, 'default');

    expect(first.isBlocked).toBe(false);
    expect(second.isBlocked).toBe(false);
    expect(first.totalHits).toBe(1);
    expect(second.totalHits).toBe(2);
  });

  it('releases redis client on shutdown', async () => {
    const { service, redisClientService } = createService();

    await service.increment('key', 60_000, 5, 60_000, 'default');
    await service.onModuleDestroy();

    expect(redisClientService.releaseClient).toHaveBeenCalledWith(
      expect.any(Object),
      'throttler-storage',
    );
  });
});
