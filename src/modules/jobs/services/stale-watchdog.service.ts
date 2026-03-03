import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { JobStatus, JobType, ProjectStatus } from '@prisma/client';
import { PrismaService } from '../../prisma';
import { parseBooleanEnv, parsePositiveIntEnv } from '../../../common/utils/env-parsers';

interface StaleProcessingJob {
  id: string;
  projectId: string;
  type: JobType;
  progress: number;
  currentStep: string | null;
  updatedAt: Date;
}

const PIPELINE_JOB_TYPES: JobType[] = [
  JobType.YOUTUBE_DOWNLOAD,
  JobType.TRANSCRIPTION,
  JobType.ANALYZE_LYRICS,
  JobType.GENERATE_IMAGES,
  JobType.RENDER_VIDEO,
  JobType.FINALIZE,
];

const PIPELINE_JOB_TYPE_SET = new Set<JobType>(PIPELINE_JOB_TYPES);

@Injectable()
export class StaleWatchdogService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StaleWatchdogService.name);
  private staleWatchdogTimer: NodeJS.Timeout | null = null;
  private staleWatchdogRunning = false;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    this.startStaleWatchdog();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopStaleWatchdog();
  }

  private startStaleWatchdog(): void {
    const enabled = parseBooleanEnv(
      'JOB_STALE_WATCHDOG_ENABLED',
      process.env.NODE_ENV !== 'test',
    );
    if (!enabled) {
      this.logger.log('[stale-watchdog] disabled by configuration');
      return;
    }

    const intervalMs = parsePositiveIntEnv('JOB_STALE_WATCHDOG_INTERVAL_MS', 60_000);
    if (this.staleWatchdogTimer) {
      clearInterval(this.staleWatchdogTimer);
      this.staleWatchdogTimer = null;
    }

    this.staleWatchdogTimer = setInterval(() => {
      void this.runStaleWatchdogCycle('interval');
    }, intervalMs);
    this.staleWatchdogTimer.unref?.();

    this.logger.log(
      `[stale-watchdog] enabled interval=${intervalMs}ms timeout=${parsePositiveIntEnv(
        'JOB_STALE_TIMEOUT_MS',
        15 * 60_000,
      )}ms`,
    );
    void this.runStaleWatchdogCycle('startup');
  }

  private stopStaleWatchdog(): void {
    if (!this.staleWatchdogTimer) {
      return;
    }
    clearInterval(this.staleWatchdogTimer);
    this.staleWatchdogTimer = null;
    this.logger.log('[stale-watchdog] stopped');
  }

  private async runStaleWatchdogCycle(trigger: 'startup' | 'interval'): Promise<void> {
    if (this.staleWatchdogRunning) {
      return;
    }
    this.staleWatchdogRunning = true;
    try {
      const staleJobs = await this.findStaleProcessingJobs();
      if (staleJobs.length === 0) {
        return;
      }

      this.logger.warn(
        `[stale-watchdog] trigger=${trigger} detected stale jobs: count=${staleJobs.length}`,
      );

      for (const staleJob of staleJobs) {
        await this.failStaleProcessingJob(staleJob);
      }
    } catch (error) {
      this.logger.error(
        `[stale-watchdog] cycle failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      this.staleWatchdogRunning = false;
    }
  }

  private async findStaleProcessingJobs(): Promise<StaleProcessingJob[]> {
    const timeoutMs = parsePositiveIntEnv('JOB_STALE_TIMEOUT_MS', 15 * 60_000);
    const batchSize = parsePositiveIntEnv('JOB_STALE_WATCHDOG_BATCH_SIZE', 20);
    const cutoff = new Date(Date.now() - timeoutMs);

    return this.prisma.job.findMany({
      where: {
        status: JobStatus.PROCESSING,
        updatedAt: { lt: cutoff },
      },
      orderBy: { updatedAt: 'asc' },
      take: batchSize,
      select: {
        id: true,
        projectId: true,
        type: true,
        progress: true,
        currentStep: true,
        updatedAt: true,
      },
    });
  }

  private async failStaleProcessingJob(staleJob: StaleProcessingJob): Promise<void> {
    const staleAgeSec = Math.max(1, Math.floor((Date.now() - staleJob.updatedAt.getTime()) / 1000));
    const staleErrorMessage = `Stale processing timeout: no heartbeat for ${staleAgeSec}s`;
    const staleCurrentStep = 'Job auto-failed by stale watchdog';

    const updated = await this.prisma.$transaction(async (tx) => {
      const failResult = await tx.job.updateMany({
        where: {
          id: staleJob.id,
          status: JobStatus.PROCESSING,
        },
        data: {
          status: JobStatus.FAILED,
          errorMessage: staleErrorMessage,
          currentStep: staleCurrentStep,
        },
      });

      if (failResult.count === 0) {
        return false;
      }

      if (PIPELINE_JOB_TYPE_SET.has(staleJob.type)) {
        await tx.job.updateMany({
          where: {
            projectId: staleJob.projectId,
            type: { in: PIPELINE_JOB_TYPES },
            status: { in: [JobStatus.PENDING, JobStatus.PROCESSING] },
          },
          data: {
            status: JobStatus.CANCELLED,
            errorMessage: 'Cancelled after stale-job watchdog intervention',
          },
        });

        await tx.project.updateMany({
          where: {
            id: staleJob.projectId,
            status: { in: [ProjectStatus.DRAFT, ProjectStatus.PROCESSING] },
          },
          data: { status: ProjectStatus.FAILED },
        });
      }

      return true;
    });

    if (updated) {
      this.logger.warn(
        `[stale-watchdog] auto-failed job=${staleJob.id} project=${staleJob.projectId} type=${staleJob.type} ageSec=${staleAgeSec}`,
      );
    }
  }
}
