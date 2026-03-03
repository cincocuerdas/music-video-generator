import { Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Job, JobStatus, JobType } from '@prisma/client';
import { PrismaService } from '../../prisma';
import { JobDispatchService } from './job-dispatch.service';

interface StyleLoraConfigEntry {
  loraFilename: string;
  loraPath: string;
  updatedAt: string;
  likesUsed?: number;
}

@Injectable()
export class StyleLoraService {
  private readonly logger = new Logger(StyleLoraService.name);
  private readonly generationConfigPath = path.join(
    process.cwd(),
    'storage',
    'generation-config.json',
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobDispatchService: JobDispatchService,
  ) {}

  async triggerStyleLoraTraining(
    projectId: string,
    style: string,
    likesCount: number,
  ): Promise<Job | null> {
    const normalizedStyle = this.normalizeStyle(style);
    if (!normalizedStyle || likesCount < 50) {
      return null;
    }

    const activeJob = await this.prisma.job.findFirst({
      where: {
        type: JobType.TRAIN_LORA,
        status: { in: [JobStatus.PENDING, JobStatus.PROCESSING] },
        inputData: {
          path: ['style'],
          equals: normalizedStyle,
        },
      },
      select: { id: true },
    });

    if (activeJob) {
      this.logger.log(
        `Skipping TRAIN_LORA enqueue for style "${normalizedStyle}": active job ${activeJob.id} already exists`,
      );
      return null;
    }

    const latestCompleted = await this.prisma.job.findFirst({
      where: {
        type: JobType.TRAIN_LORA,
        status: JobStatus.COMPLETED,
        inputData: {
          path: ['style'],
          equals: normalizedStyle,
        },
      },
      orderBy: { createdAt: 'desc' },
      select: { outputData: true },
    });

    const lastLikesUsed = this.extractLikesUsed(latestCompleted?.outputData);
    if (likesCount < lastLikesUsed + 50) {
      this.logger.log(
        `Skipping TRAIN_LORA for style "${normalizedStyle}": likes=${likesCount}, lastTrainingLikes=${lastLikesUsed}`,
      );
      return null;
    }

    const trainJob = await this.prisma.job.create({
      data: {
        projectId,
        type: JobType.TRAIN_LORA,
        inputData: {
          style: normalizedStyle,
          likesCount,
          triggeredAt: new Date().toISOString(),
        },
      },
    });

    await this.jobDispatchService.dispatch(trainJob, async () => undefined);
    this.logger.log(
      `TRAIN_LORA queued for style "${normalizedStyle}" (likes=${likesCount}) via project ${projectId}`,
    );

    return trainJob;
  }

  async updateStyleLoraConfig(
    style: string,
    payload: { loraFilename: string; loraPath: string; likesUsed?: number },
  ): Promise<void> {
    const normalizedStyle = this.normalizeStyle(style);
    if (!normalizedStyle) {
      return;
    }

    const config = await this.readGenerationConfig();
    const styleLoras = (config.styleLoras ?? {}) as Record<string, StyleLoraConfigEntry>;

    styleLoras[normalizedStyle] = {
      loraFilename: payload.loraFilename,
      loraPath: payload.loraPath,
      likesUsed: payload.likesUsed,
      updatedAt: new Date().toISOString(),
    };

    config.styleLoras = styleLoras;
    await this.writeGenerationConfig(config);

    this.logger.log(
      `Generation config updated for style "${normalizedStyle}" with LoRA ${payload.loraFilename}`,
    );
  }

  private extractLikesUsed(outputData: unknown): number {
    if (!outputData || typeof outputData !== 'object') {
      return 0;
    }

    const likes = (outputData as Record<string, unknown>).likesCount;
    return typeof likes === 'number' && Number.isFinite(likes) ? likes : 0;
  }

  private normalizeStyle(style: string): string {
    return style?.trim().toLowerCase() || '';
  }

  private async readGenerationConfig(): Promise<Record<string, unknown>> {
    try {
      const raw = await fs.readFile(this.generationConfigPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
      return {};
    } catch {
      return {};
    }
  }

  private async writeGenerationConfig(config: Record<string, unknown>): Promise<void> {
    const dirPath = path.dirname(this.generationConfigPath);
    await fs.mkdir(dirPath, { recursive: true });
    await fs.writeFile(this.generationConfigPath, JSON.stringify(config, null, 2), 'utf-8');
  }
}

