import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { JobStatus } from '@prisma/client';
import { PrismaService } from '../../prisma';
import { PipelineDispatchCoordinatorService } from './pipeline-dispatch-coordinator.service';
import { DeadLetterEntry, DeadLetterService } from './dead-letter.service';

@Injectable()
export class DeadLetterReplayService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly deadLetterService: DeadLetterService,
    private readonly pipelineDispatchCoordinatorService: PipelineDispatchCoordinatorService,
  ) {}

  async replayForUser(deadLetterId: string, userId: string): Promise<Record<string, unknown>> {
    const deadLetterJob = await this.deadLetterService.getJob(deadLetterId);
    if (!deadLetterJob) {
      throw new NotFoundException(`Dead-letter job ${deadLetterId} not found`);
    }

    const data =
      deadLetterJob.data && typeof deadLetterJob.data === 'object'
        ? (deadLetterJob.data as Partial<DeadLetterEntry> & Record<string, unknown>)
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

    await this.pipelineDispatchCoordinatorService.dispatch(replayed);
    await this.deadLetterService.updateJobData(deadLetterId, {
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
