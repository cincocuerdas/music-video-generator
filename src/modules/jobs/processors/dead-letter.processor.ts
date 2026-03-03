import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { QUEUE_NAMES } from '../../queue';
import { DeadLetterEntry } from '../services/dead-letter.service';

@Processor(QUEUE_NAMES.DEAD_LETTER)
export class DeadLetterProcessor extends WorkerHost {
  private readonly logger = new Logger(DeadLetterProcessor.name);

  async process(job: Job<DeadLetterEntry>): Promise<Record<string, unknown>> {
    const payload = job.data;
    const summary = {
      deadLetterJobId: String(job.id),
      sourceQueue: payload?.sourceQueue ?? 'unknown',
      projectId: payload?.projectId ?? 'unknown',
      originalJobId: payload?.jobId ?? 'unknown',
      jobType: payload?.jobType ?? 'unknown',
      retryable: Boolean(payload?.retryable),
      category: payload?.category ?? 'unknown',
      capturedAt: payload?.capturedAt ?? null,
    };

    this.logger.warn(
      `[dead-letter] queued entry source=${summary.sourceQueue} project=${summary.projectId} originalJob=${summary.originalJobId} type=${summary.jobType} retryable=${summary.retryable} category=${summary.category}`,
    );

    return summary;
  }
}

