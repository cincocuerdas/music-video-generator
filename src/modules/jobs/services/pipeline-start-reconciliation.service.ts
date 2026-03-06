import { Injectable, Logger } from '@nestjs/common';
import { Job, JobStatus, JobType, ProjectStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PIPELINE_JOB_TYPES } from '../pipeline.constants';
import { PipelineDefinition } from './pipeline-orchestrator.service';
import { toStructuredLog } from '../../../common/utils/structured-log.util';

type StartPipelineMode = 'created' | 'reused';

export interface StartPipelineResult {
  jobs: Job[];
  mode: StartPipelineMode;
}

interface SyntheticRunMetadata {
  isSynthetic: boolean;
  runType: 'smoke' | 'chaos' | null;
}

interface ReconciliationProject {
  id: string;
  title: string | null;
  status: ProjectStatus;
}

/** Prisma transaction client (subset used by this service). */
type TxClient = {
  job: {
    findMany: (args: unknown) => Promise<Job[]>;
    updateMany: (args: unknown) => Promise<unknown>;
    deleteMany: (args: unknown) => Promise<unknown>;
    create: (args: unknown) => Promise<Job>;
  };
  project: {
    update: (args: unknown) => Promise<unknown>;
  };
};

@Injectable()
export class PipelineStartReconciliationService {
  private readonly logger = new Logger(PipelineStartReconciliationService.name);

  classifySyntheticRun(title?: string | null): SyntheticRunMetadata {
    const normalized = (title || '').trim().toLowerCase();
    if (!normalized) {
      return { isSynthetic: false, runType: null };
    }
    if (
      normalized.includes('[synthetic:chaos]') ||
      normalized.includes('external chaos') ||
      normalized.includes('latency chaos')
    ) {
      return { isSynthetic: true, runType: 'chaos' };
    }
    if (normalized.includes('[synthetic:smoke]') || normalized.includes('smoke baseline')) {
      return { isSynthetic: true, runType: 'smoke' };
    }
    return { isSynthetic: false, runType: null };
  }

  /**
   * Reconcile existing pipeline jobs inside an open transaction.
   *
   * Handles three scenarios:
   * 1. Active pipeline exists → return jobs with mode 'reused'
   * 2. No active pipeline → clean old jobs, create fresh pipeline, mode 'created'
   * 3. Duplicate active stages → cancel duplicates first, then decide 1 or 2
   */
  async reconcile(
    tx: TxClient,
    project: ReconciliationProject,
    pipelineDefinition: PipelineDefinition,
  ): Promise<StartPipelineResult> {
    const projectId = project.id;

    const existingPipelineJobs = await tx.job.findMany({
      where: {
        projectId,
        type: { in: PIPELINE_JOB_TYPES },
      },
      orderBy: { createdAt: 'asc' },
    });

    const canonicalJobs = await this.cancelDuplicateActiveStages(tx, projectId, existingPipelineJobs);

    const hasActivePipelineJobs = canonicalJobs.some(
      (job) => job.status === JobStatus.PENDING || job.status === JobStatus.PROCESSING,
    );

    if (hasActivePipelineJobs) {
      if (project.status !== ProjectStatus.PROCESSING) {
        await tx.project.update({
          where: { id: projectId },
          data: { status: ProjectStatus.PROCESSING },
        });
      }
      return { jobs: canonicalJobs, mode: 'reused' };
    }

    if (project.status !== ProjectStatus.DRAFT) {
      this.logger.warn(
        toStructuredLog('pipeline.start.restart_non_draft', {
          projectId,
          status: project.status,
        }),
      );
    }

    const createdJobs = await this.createFreshPipeline(tx, project, pipelineDefinition);
    return { jobs: createdJobs, mode: 'created' };
  }

  private async cancelDuplicateActiveStages(
    tx: TxClient,
    projectId: string,
    existingJobs: Job[],
  ): Promise<Job[]> {
    const activeStatuses = new Set<JobStatus>([JobStatus.PENDING, JobStatus.PROCESSING]);
    const duplicateActiveJobIds: string[] = [];
    const seenActiveStages = new Set<JobType>();

    for (const pipelineJob of existingJobs) {
      if (!activeStatuses.has(pipelineJob.status)) {
        continue;
      }
      if (seenActiveStages.has(pipelineJob.type)) {
        duplicateActiveJobIds.push(pipelineJob.id);
        continue;
      }
      seenActiveStages.add(pipelineJob.type);
    }

    if (duplicateActiveJobIds.length === 0) {
      return existingJobs;
    }

    await tx.job.updateMany({
      where: {
        id: { in: duplicateActiveJobIds },
        status: { in: [JobStatus.PENDING, JobStatus.PROCESSING] },
      },
      data: {
        status: JobStatus.CANCELLED,
        errorMessage: 'Cancelled duplicate active stage during idempotent pipeline start.',
      },
    });

    return tx.job.findMany({
      where: {
        projectId,
        type: { in: PIPELINE_JOB_TYPES },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  private async createFreshPipeline(
    tx: TxClient,
    project: ReconciliationProject,
    pipelineDefinition: PipelineDefinition,
  ): Promise<Job[]> {
    const projectId = project.id;

    await tx.job.deleteMany({
      where: {
        projectId,
        type: { in: PIPELINE_JOB_TYPES },
      },
    });

    await tx.project.update({
      where: { id: projectId },
      data: { status: ProjectStatus.PROCESSING },
    });

    const createdJobs: Job[] = [];
    const pipelineCorrelationId = `pipeline:${projectId}:${randomUUID().slice(0, 8)}`;
    const syntheticRun = this.classifySyntheticRun(project.title);

    for (let i = 0; i < pipelineDefinition.order.length; i++) {
      const job = await tx.job.create({
        data: {
          projectId,
          type: pipelineDefinition.order[i],
          status: JobStatus.PENDING,
          inputData: {
            correlationId: pipelineCorrelationId,
            sourceMode: pipelineDefinition.source,
            isSynthetic: syntheticRun.isSynthetic,
            ...(syntheticRun.runType ? { syntheticRunType: syntheticRun.runType } : {}),
          },
        },
      });
      createdJobs.push(job);
    }

    if (syntheticRun.isSynthetic) {
      this.logger.log(
        toStructuredLog('pipeline.synthetic.tagged', {
          projectId,
          runType: syntheticRun.runType,
        }),
      );
    }

    return createdJobs;
  }
}
