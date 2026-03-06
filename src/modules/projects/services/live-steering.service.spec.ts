import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LiveSteeringService } from './live-steering.service';

describe('LiveSteeringService', () => {
  const redisClient = {
    set: jest.fn().mockResolvedValue('OK'),
    expire: jest.fn().mockResolvedValue(1),
    del: jest.fn().mockResolvedValue(1),
  };

  const redisClientService = {
    createClient: jest.fn(() => redisClient),
    releaseClient: jest.fn().mockResolvedValue(undefined),
  };

  const eventsGateway = {
    emitSteeringReceived: jest.fn(),
  };

  let tempRoot: string;
  let cwdSpy: jest.SpyInstance<string, []>;
  let service: LiveSteeringService;

  beforeEach(async () => {
    jest.clearAllMocks();
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'live-steering-'));
    cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(tempRoot);
    service = new LiveSteeringService(
      redisClientService as never,
      eventsGateway as never,
    );
  });

  afterEach(async () => {
    cwdSpy.mockRestore();
    await service.onModuleDestroy();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('writes the live signal to disk and redis', async () => {
    const result = await service.saveLiveSignal('project-1', {
      type: 'boost',
      sceneIndex: 2,
      intensity: 0.8,
    });

    const filePath = path.join(tempRoot, 'output', 'live-signals', 'project-1.json');
    const persisted = JSON.parse(await fs.readFile(filePath, 'utf-8'));

    expect(persisted.type).toBe('boost');
    expect(persisted.sceneIndex).toBe(2);
    expect(persisted.intensity).toBe(0.8);
    expect(persisted.processed).toBe(false);
    expect(redisClient.set).toHaveBeenCalledWith('steering:project-1', expect.any(String));
    expect(redisClient.expire).toHaveBeenCalledWith('steering:project-1', 300);
    expect(eventsGateway.emitSteeringReceived).toHaveBeenCalledWith('project-1', {
      signalType: 'boost',
      sceneIndex: 2,
      status: 'queued',
    });
    expect(result.success).toBe(true);
  });

  it('returns null when the live signal file does not exist', async () => {
    await expect(service.getLiveSignal('missing-project')).resolves.toBeNull();
  });

  it('reads and clears the live signal file', async () => {
    await service.saveLiveSignal('project-2', {
      type: 'correct',
      sceneIndex: 4,
      reason: 'reduce crowd size',
    });

    const loaded = await service.getLiveSignal('project-2');
    expect(loaded).toMatchObject({
      type: 'correct',
      sceneIndex: 4,
      reason: 'reduce crowd size',
      processed: false,
    });

    await expect(service.clearLiveSignal('project-2')).resolves.toEqual({
      success: true,
      message: 'Signal cleared',
    });

    await expect(service.getLiveSignal('project-2')).resolves.toBeNull();
    expect(redisClient.del).toHaveBeenCalledWith('steering:project-2');
  });
});
