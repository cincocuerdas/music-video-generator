import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Job as QueueJob, Queue } from 'bullmq';
import { JobType } from '@prisma/client';
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
    @InjectQueue(QUEUE_NAMES.DEAD_LETTER)
    private readonly deadLetterQueue: Queue,
  ) {}

  async enqueue(entry: DeadLetterEntry): Promise<void> {
    await this.deadLetterQueue.add('dead-letter', entry, {
      removeOnComplete: 500,
      removeOnFail: 1000,
    });
  }

  async listJobs(limit = 25): Promise<QueueJob<DeadLetterEntry>[]> {
    const safeLimit = Math.max(1, Math.min(limit, 100));
    return this.deadLetterQueue.getJobs(
      ['waiting', 'active', 'delayed', 'completed', 'failed'],
      0,
      safeLimit - 1,
      true,
    );
  }

  async getJob(deadLetterId: string): Promise<QueueJob<DeadLetterEntry> | undefined> {
    return this.deadLetterQueue.getJob(deadLetterId);
  }

  async updateJobData(
    deadLetterId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const deadLetterJob = await this.deadLetterQueue.getJob(deadLetterId);
    if (!deadLetterJob) {
      return;
    }
    await deadLetterJob.updateData(payload);
  }
}
