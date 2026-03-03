import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Job, JobStatus, JobType } from '@prisma/client';
import { PrismaService } from '../../prisma';
import { QUEUE_NAMES } from '../../queue';

export interface DeadLetterEntry {
  sourceQueue: string;
  projectId: string;
  jobId: string;
  jobType: JobType;
  correlationId: string;
  message: string;
  attemptsMade: number;
  maxAttempts: number;
  retryable: boolean;
  category: 'transient' | 'permanent' | 'unknown';
  payload?: Record<string, unknown>;
  capturedAt: string;
}

@Injectable()
export class DeadLetterService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUE_NAMES.DEAD_LETTER)
    private readonly deadLetterQueue: Queue,
  ) {}

  async enqueue(entry: DeadLetterEntry): Promise<void> {
    await this.deadLetterQueue.add('dead-letter', entry, {
      removeOnComplete: 500,
      removeOnFail: 1000,
    });
  }

  async listForUser(userId: string, limit = 25): Promise<Record<string, unknown>> {
    const safeLimit = Math.max(1, Math.min(limit, 100));
    const jobs = await this.deadLetterQueue.getJobs(
      ['waiting', 'active', 'delayed', 'completed', 'failed'],
      0,
      safeLimit - 1,
      true,
    );

    const projectIds = Array.from(
      new Set(
        jobs
          .map((queueJob) =>
            queueJob.data && typeof queueJob.data === 'object'
              ? (queueJob.data as Record<string, unknown>).projectId
              : null,
          )
          .filter((value): value is string => typeof value === 'string'),
      ),
    );

    const ownedProjects = await this.prisma.project.findMany({
      where: { userId, id: { in: projectIds } },
      select: { id: true },
    });
    const ownedProjectIds = new Set(ownedProjects.map((project) => project.id));

    const ownedItems = jobs.filter((queueJob) => {
      const projectId =
        queueJob.data && typeof queueJob.data === 'object'
          ? (queueJob.data as Record<string, unknown>).projectId
          : null;
      return typeof projectId === 'string' && ownedProjectIds.has(projectId);
    });

    const items = await Promise.all(
      ownedItems.map(async (queueJob) => ({
        deadLetterId: String(queueJob.id),
        status: await queueJob.getState(),
        name: queueJob.name,
        attemptsMade: queueJob.attemptsMade,
        failedReason: queueJob.failedReason || null,
        timestamp: queueJob.timestamp,
        data: queueJob.data,
      })),
    );

    return {
      total: items.length,
      items,
    };
  }

  async replayForUser(
    deadLetterId: string,
    userId: string,
    dispatchJob: (job: Job) => Promise<void>,
  ): Promise<Record<string, unknown>> {
    const deadLetterJob = await this.deadLetterQueue.getJob(deadLetterId);
    if (!deadLetterJob) {
      throw new NotFoundException(`Dead-letter job ${deadLetterId} not found`);
    }

    const data =
      deadLetterJob.data && typeof deadLetterJob.data === 'object'
        ? (deadLetterJob.data as Record<string, unknown>)
        : {};
    const projectId = typeof data.projectId === 'string' ? data.projectId : '';
    if (!projectId) {
      throw new BadRequestException('Dead-letter payload does not include projectId');
    }

    await this.assertProjectOwnership(projectId, userId);

    const originalJobId = typeof data.jobId === 'string' ? data.jobId : '';
    if (!originalJobId) {
      throw new BadRequestException('Dead-letter payload does not include original jobId');
    }

    const originalJob = await this.prisma.job.findUnique({ where: { id: originalJobId } });
    if (!originalJob) {
      throw new NotFoundException(`Original job ${originalJobId} not found`);
    }

    if (originalJob.status === JobStatus.PENDING || originalJob.status === JobStatus.PROCESSING) {
      return {
        replayed: false,
        reason: `Job ${originalJobId} is already ${originalJob.status}`,
        jobId: originalJobId,
      };
    }

    const replayed = await this.prisma.job.update({
      where: { id: originalJob.id },
      data: {
        status: JobStatus.PENDING,
        progress: 0,
        currentStep: 'Replay requested from dead-letter queue',
        errorMessage: null,
        workerId: null,
      },
    });

    await dispatchJob(replayed);
    await deadLetterJob.updateData({
      ...data,
      replayedAt: new Date().toISOString(),
      replayedOriginalJobId: originalJobId,
    });

    return {
      replayed: true,
      deadLetterId,
      jobId: replayed.id,
      projectId: replayed.projectId,
      type: replayed.type,
    };
  }

  private async assertProjectOwnership(projectId: string, userId: string): Promise<void> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, userId },
      select: { id: true },
    });

    if (!project) {
      throw new NotFoundException(`Project with id ${projectId} not found`);
    }
  }
}

