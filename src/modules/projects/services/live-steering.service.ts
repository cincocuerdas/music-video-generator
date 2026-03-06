import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { RedisClientService } from '../../redis';
import { EventsGateway } from '../../events/events.gateway';
import { promises as fs } from 'fs';
import * as path from 'path';
import Redis from 'ioredis';

@Injectable()
export class LiveSteeringService implements OnModuleDestroy {
  private readonly logger = new Logger(LiveSteeringService.name);
  private redisClient: Redis | null = null;

  constructor(
    private readonly redisClientService: RedisClientService,
    private readonly eventsGateway: EventsGateway,
  ) {
    this.initRedis();
  }

  private async initRedis() {
    try {
      this.redisClient = this.redisClientService.createClient('projects-steering');
      this.logger.log('Redis client initialized for live steering');
    } catch (error) {
      this.logger.warn(`Redis not available for steering: ${error.message}`);
    }
  }

  async onModuleDestroy() {
    if (this.redisClient) {
      await this.redisClientService.releaseClient(this.redisClient, 'projects-steering');
      this.redisClient = null;
    }
  }

  private getSignalsDir(): string {
    return path.join(process.cwd(), 'output', 'live-signals');
  }

  private async getLiveSignalPath(projectId: string): Promise<string> {
    const signalsDir = this.getSignalsDir();
    await fs.mkdir(signalsDir, { recursive: true });
    return path.join(signalsDir, `${projectId}.json`);
  }

  async saveLiveSignal(
    projectId: string,
    signal: { type: 'boost' | 'correct'; sceneIndex: number; timestamp?: number; intensity?: number; reason?: string },
  ) {
    const filePath = await this.getLiveSignalPath(projectId);

    const signalData = {
      ...signal,
      timestamp: signal.timestamp || Date.now(),
      intensity: signal.intensity || 1.0,
      processed: false,
    };

    // 1. Write to file (fallback for Python)
    await fs.writeFile(filePath, JSON.stringify(signalData, null, 2), 'utf-8');

    // 2. Write to Redis (faster for Python to read)
    if (this.redisClient) {
      try {
        const redisKey = `steering:${projectId}`;
        await this.redisClient.set(redisKey, JSON.stringify(signalData));
        await this.redisClient.expire(redisKey, 300);
        this.logger.debug(`Signal saved to Redis: ${redisKey}`);
      } catch (error) {
        this.logger.warn(`Failed to save signal to Redis: ${error.message}`);
      }
    }

    // 3. Emit immediate WebSocket acknowledgment
    this.eventsGateway.emitSteeringReceived(projectId, {
      signalType: signal.type,
      sceneIndex: signal.sceneIndex,
      status: 'queued',
    });

    this.logger.log(
      `🎬 Live signal saved: ${signal.type} at scene ${signal.sceneIndex} for project ${projectId}`,
    );

    return {
      success: true,
      message: signal.type === 'boost'
        ? '✅ Style locked in for next scenes'
        : '🔄 Adjusting direction for upcoming scenes',
      signal: signalData,
    };
  }

  async getLiveSignal(projectId: string) {
    const filePath = path.join(this.getSignalsDir(), `${projectId}.json`);

    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      this.logger.warn(`Failed to read live signal for ${projectId}: ${error.message}`);
    }

    return null;
  }

  async clearLiveSignal(projectId: string) {
    const filePath = path.join(this.getSignalsDir(), `${projectId}.json`);

    // 1. Clear file
    try {
      await fs.unlink(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      this.logger.warn(`Failed to clear live signal file for ${projectId}: ${error.message}`);
      }
    }

    // 2. Clear Redis
    if (this.redisClient) {
      try {
        const redisKey = `steering:${projectId}`;
        await this.redisClient.del(redisKey);
      } catch (error) {
        this.logger.warn(`Failed to clear live signal from Redis for ${projectId}: ${error.message}`);
      }
    }

    this.logger.log(`🎬 Live signal cleared for project ${projectId}`);

    return {
      success: true,
      message: 'Signal cleared',
    };
  }
}
