import { Injectable } from '@nestjs/common';
import { Job } from '@prisma/client';
import { JobDispatchService } from './job-dispatch.service';
import { JobStateService } from './job-state.service';
import { PipelineLifecycleService } from './pipeline-lifecycle.service';

@Injectable()
export class PipelineDispatchCoordinatorService {
  constructor(
    private readonly jobDispatchService: JobDispatchService,
    private readonly jobStateService: JobStateService,
    private readonly pipelineLifecycleService: PipelineLifecycleService,
  ) {}

  async dispatch(job: Job): Promise<void> {
    await this.jobDispatchService.dispatch(job, async (finalizeJob) => {
      await this.jobStateService.markAsCompleted(finalizeJob.id, { finalized: true });
      await this.pipelineLifecycleService.advancePipeline(finalizeJob.projectId, async (nextJob) =>
        this.dispatch(nextJob),
      );
    });
  }
}
