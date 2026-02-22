import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { RedisClientService } from './redis-client.service';

type EventHandler = (...args: any[]) => void;

const redisMockState: {
  instances: MockRedisClient[];
  nextConnectError: Error | null;
} = {
  instances: [],
  nextConnectError: null,
};

class MockRedisClient {
  public status = 'ready';
  public readonly handlers = new Map<string, EventHandler[]>();
  public readonly connect = jest.fn(async () => {
    if (redisMockState.nextConnectError) {
      const err = redisMockState.nextConnectError;
      redisMockState.nextConnectError = null;
      throw err;
    }
    return 'OK';
  });
  public readonly quit = jest.fn(async () => 'OK');
  public readonly disconnect = jest.fn();

  constructor(
    public readonly url: string,
    public readonly options: Record<string, any>,
  ) {}

  on = jest.fn((event: string, handler: EventHandler) => {
    const list = this.handlers.get(event) || [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  });

  emit(event: string, ...args: any[]) {
    const list = this.handlers.get(event) || [];
    for (const handler of list) {
      handler(...args);
    }
  }
}

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn((url: string, options: Record<string, any>) => {
    const client = new MockRedisClient(url, options);
    redisMockState.instances.push(client);
    return client;
  }),
}));

const flushPromises = async () => {
  await new Promise((resolve) => setImmediate(resolve));
};

describe('RedisClientService', () => {
  const redisCtorMock = Redis as unknown as jest.Mock;
  let service: RedisClientService;

  beforeEach(() => {
    redisMockState.instances = [];
    redisMockState.nextConnectError = null;
    redisCtorMock.mockClear();

    const configValues: Record<string, any> = {
      'redis.url': 'redis://redis.internal:6379',
      'redis.connectTimeoutMs': 11_000,
      'redis.retryBaseDelayMs': 300,
      'redis.retryMaxDelayMs': 4_000,
      'redis.maxRetriesPerRequest': null,
      'redis.enableOfflineQueue': true,
    };

    const configService = {
      get: jest.fn((key: string) => configValues[key]),
    } as unknown as ConfigService;

    service = new RedisClientService(configService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('creates clients with lazyConnect and triggers explicit connect', () => {
    service.createClient('events-subscriber');

    expect(redisCtorMock).toHaveBeenCalledTimes(1);
    expect(redisCtorMock).toHaveBeenCalledWith(
      'redis://redis.internal:6379',
      expect.objectContaining({
        connectTimeout: 11_000,
        enableOfflineQueue: true,
        maxRetriesPerRequest: null,
        lazyConnect: true,
      }),
    );

    const client = redisMockState.instances[0];
    expect(client.connect).toHaveBeenCalledTimes(1);
  });

  it('throttles repeated error logs for the same label', () => {
    const logger = (service as any).logger;
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    const debugSpy = jest.spyOn(logger, 'debug').mockImplementation(() => undefined);
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValueOnce(10_000).mockReturnValueOnce(10_100);

    const client = service.createClient('projects-steering') as unknown as MockRedisClient;
    client.emit('error', new Error('first'));
    client.emit('error', new Error('second'));

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining('Redis error (throttled): second'),
    );
  });

  it('throttles repeated reconnecting logs for the same label', () => {
    const logger = (service as any).logger;
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const debugSpy = jest.spyOn(logger, 'debug').mockImplementation(() => undefined);
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValueOnce(20_000).mockReturnValueOnce(20_200);

    const client = service.createClient('events-publisher') as unknown as MockRedisClient;
    client.emit('reconnecting', 500);
    client.emit('reconnecting', 800);

    expect(warnSpy).toHaveBeenCalledWith('[events-publisher] Redis reconnecting in 500ms');
    expect(debugSpy).toHaveBeenCalledWith(
      '[events-publisher] Redis reconnecting (throttled) in 800ms',
    );
  });

  it('logs connect failures without throwing', async () => {
    const logger = (service as any).logger;
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => undefined);

    redisMockState.nextConnectError = new Error('connect refused');
    service.createClient('events-subscriber');
    await flushPromises();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Redis connect failed: connect refused'),
    );
  });

  it('disconnects ended clients without quit in releaseClient', async () => {
    const logger = (service as any).logger;
    jest.spyOn(logger, 'log').mockImplementation(() => undefined);

    const client = service.createClient('events-subscriber') as unknown as MockRedisClient;
    client.status = 'end';

    await service.releaseClient(client as unknown as any, 'events-subscriber');

    expect(client.disconnect).toHaveBeenCalledWith(false);
    expect(client.quit).not.toHaveBeenCalled();
  });
});
