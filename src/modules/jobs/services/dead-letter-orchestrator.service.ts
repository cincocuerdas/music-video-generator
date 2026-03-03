import { Injectable } from '@nestjs/common';
import { Job } from '@prisma/client';
import { DeadLetterEntry, DeadLetterService } from './dead-letter.service';
import { JobsService } from '../jobs.service';

@Injectable()
export class DeadLetterOrchestratorService {
  constructor(
    private readonly deadLetterService: DeadLetterService,
    private readonly jobsService: JobsService,
  ) {}

  async enqueue(entry: DeadLetterEntry): Promise<void> {
    await this.deadLetterService.enqueue(entry);
  }

  async listForUser(userId: string, limit = 25): Promise<Record<string, unknown>> {
    return this.deadLetterService.listForUser(userId, limit);
  }

  async replayForUser(deadLetterId: string, userId: string): Promise<Record<string, unknown>> {
    return this.deadLetterService.replayForUser(
      deadLetterId,
      userId,
      async (job: Job) => this.jobsService.dispatchPipelineJob(job),
    );
  }
}

