import { Injectable, NotFoundException } from '@nestjs/common';
import { Job, JobStatus } from '@prisma/client';
import { PrismaService } from '../../prisma';
import {
  deriveProjectPipelineStatus,
  isCorePipelineJob,
  summarizePipelineQuality,
} from '../pipeline-quality.utils';
import type { PipelineStatus } from '../types/pipeline-status.type';

@Injectable()
export class PipelineStatusService {
  constructor(private readonly prisma: PrismaService) {}

  async getPipelineStatus(projectId: string): Promise<PipelineStatus> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });

    if (!project) {
      throw new NotFoundException(`Project with id ${projectId} not found`);
    }

    const jobs = await this.prisma.job.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
    });

    const currentJob = jobs.find((job) => job.status === JobStatus.PROCESSING);
    const pipelineJobs = jobs.filter((job) => isCorePipelineJob(job.type));
    const quality = summarizePipelineQuality(pipelineJobs);

    return {
      projectId,
      projectStatus: project.status,
      pipelineStatus: deriveProjectPipelineStatus(project.status, quality),
      degraded: quality.degraded,
      degradedReasons: quality.degradedReasons,
      degradedReasonCodes: quality.degradedReasonCodes,
      jobs: jobs.map((job) => this.toJobStatusView(job)),
      currentJob: currentJob?.type ?? null,
      overallProgress: this.calculateOverallProgress(pipelineJobs),
    };
  }

  private calculateOverallProgress(pipelineJobs: Job[]): number {
    const normalizedPipelineProgress = pipelineJobs.reduce((sum, job) => {
      if (job.status === JobStatus.COMPLETED) {
        return sum + 100;
      }

      if (job.status === JobStatus.PROCESSING) {
        const safeProgress = Math.max(0, Math.min(100, job.progress || 0));
        return sum + safeProgress;
      }

      return sum;
    }, 0);

    return pipelineJobs.length > 0
      ? Math.round(normalizedPipelineProgress / pipelineJobs.length)
      : 0;
  }

  private toJobStatusView(job: Job): PipelineStatus['jobs'][number] {
    return {
      type: job.type,
      status: job.status,
      progress: job.progress,
      currentStep: job.currentStep,
      errorMessage: job.errorMessage,
    };
  }
}

