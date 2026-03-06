import { Injectable } from '@nestjs/common';
import { DeadLetterEntry, DeadLetterService } from './dead-letter.service';
import { DeadLetterQueryService } from './dead-letter-query.service';
import { DeadLetterReplayService } from './dead-letter-replay.service';

@Injectable()
export class DeadLetterOrchestratorService {
  constructor(
    private readonly deadLetterService: DeadLetterService,
    private readonly deadLetterQueryService: DeadLetterQueryService,
    private readonly deadLetterReplayService: DeadLetterReplayService,
  ) {}

  async enqueue(entry: DeadLetterEntry): Promise<void> {
    await this.deadLetterService.enqueue(entry);
  }

  async listForUser(userId: string, limit = 25): Promise<Record<string, unknown>> {
    return this.deadLetterQueryService.listForUser(userId, limit);
  }

  async replayForUser(deadLetterId: string, userId: string): Promise<Record<string, unknown>> {
    return this.deadLetterReplayService.replayForUser(deadLetterId, userId);
  }
}
