import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Job, JobStatus, ProjectStatus } from '@prisma/client';
import { PrismaService } from '../../prisma';
import { PIPELINE_JOB_TYPES, PIPELINE_JOB_TYPE_SET } from '../pipeline.constants';
import { UpdateJobDto } from '../types/jobs-crud.type';
import {
  extractDegradedReasonCodesFromOutputData,
  extractDegradedReasonsFromOutputData,
} from '../pipeline-quality.utils';
import { ProjectPipelineQualityService } from './project-pipeline-quality.service';
import { toStructuredLog } from '../../../common/utils/structured-log.util';

@Injectable()
export class JobStateService {
  private readonly logger = new Logger(JobStateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly projectPipelineQualityService: ProjectPipelineQualityService,
  ) {}

  async update(id: string, data: UpdateJobDto): Promise<Job> {
    const job = await this.prisma.job.findUnique({
      where: { id },
    });
    if (!job) throw new NotFoundException(`Job with id ${id} not found`);
    return this.prisma.job.update({
      where: { id },
      data,
    });
  }

  async markAsProcessing(id: string, workerId: string): Promise<Job> {
    this.logger.log(
      toStructuredLog('job.processing', {
        jobId: id,
        workerId,
      }),
    );
    return this.update(id, {
      status: JobStatus.PROCESSING,
      workerId,
    });
  }

  async markAsCompleted(id: string, outputData: unknown): Promise<Job> {
    this.logger.log(
      toStructuredLog('job.completed', {
        jobId: id,
      }),
    );
    const completedJob = await this.update(id, {
      status: JobStatus.COMPLETED,
      progress: 100,
      outputData: outputData as Record<string, any>,
    });

    if (PIPELINE_JOB_TYPE_SET.has(completedJob.type)) {
      const degradedReasons = extractDegradedReasonsFromOutputData(outputData, completedJob.type);
      const degradedReasonCodes = extractDegradedReasonCodesFromOutputData(
        outputData,
        completedJob.type,
      );
      await this.projectPipelineQualityService.appendDegradedMeta(
        completedJob.projectId,
        degradedReasons,
        degradedReasonCodes,
      );
      await this.projectPipelineQualityService.appendStageMetrics(
        completedJob.projectId,
        completedJob.type,
        outputData,
      );
    }

    return completedJob;
  }

  async markAsFailed(id: string, error: string): Promise<Job> {
    this.logger.error(
      toStructuredLog('job.failed', {
        jobId: id,
        error,
      }),
    );
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.job.update({
        where: { id },
        data: {
          status: JobStatus.FAILED,
          errorMessage: error,
        },
      });

      if (PIPELINE_JOB_TYPE_SET.has(updated.type)) {
        await tx.job.updateMany({
          where: {
            projectId: updated.projectId,
            type: { in: PIPELINE_JOB_TYPES },
            id: { not: updated.id },
            status: { in: [JobStatus.PENDING, JobStatus.PROCESSING] },
          },
          data: { status: JobStatus.CANCELLED },
        });

        await tx.project.update({
          where: { id: updated.projectId },
          data: { status: ProjectStatus.FAILED },
        });
      }

      return updated;
    });
  }

  async updateProgress(id: string, progress: number, currentStep?: string): Promise<Job> {
    return this.update(id, {
      progress,
      currentStep,
    });
  }
}
