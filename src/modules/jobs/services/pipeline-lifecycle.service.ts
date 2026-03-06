import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Job, JobStatus, JobType, ProjectStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma';
import { PIPELINE_JOB_TYPES } from '../pipeline.constants';
import { PipelineOrchestratorService } from './pipeline-orchestrator.service';
import { PipelineTransitionService } from './pipeline-transition.service';
import { ProjectPipelineQualityService } from './project-pipeline-quality.service';
import { toStructuredLog } from '../../../common/utils/structured-log.util';

type StartPipelineMode = 'created' | 'reused';

interface StartPipelineResult {
  jobs: Job[];
  mode: StartPipelineMode;
}

interface SyntheticRunMetadata {
  isSynthetic: boolean;
  runType: 'smoke' | 'chaos' | null;
}

@Injectable()
export class PipelineLifecycleService {
  private readonly logger = new Logger(PipelineLifecycleService.name);

  private classifySyntheticRun(title?: string | null): SyntheticRunMetadata {
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

  constructor(
    private readonly prisma: PrismaService,
    private readonly pipelineOrchestrator: PipelineOrchestratorService,
    private readonly pipelineTransitionService: PipelineTransitionService,
    private readonly projectPipelineQualityService: ProjectPipelineQualityService,
  ) {}

  async startPipeline(
    projectId: string,
    dispatchJob: (job: Job) => Promise<void>,
  ): Promise<Job[]> {
    this.logger.log(
      toStructuredLog('pipeline.start.requested', {
        projectId,
      }),
    );
    try {
      const startResult = await this.prisma.$transaction(
        async (tx): Promise<StartPipelineResult> => {
          // Prevent concurrent start requests from creating duplicate pipelines.
          await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${projectId}::uuid FOR UPDATE`;

          const project = await tx.project.findUnique({
            where: { id: projectId },
            select: {
              id: true,
              title: true,
              status: true,
              sourceMode: true,
              youtubeUrl: true,
              audioUrl: true,
              lyrics: true,
            },
          });

          if (!project) {
            throw new NotFoundException(`Project with id ${projectId} not found`);
          }

          this.pipelineOrchestrator.ensureProviderPreflight();
          this.pipelineOrchestrator.ensureProjectPreflight(project);
          const pipelineDefinition = this.pipelineOrchestrator.buildPipelineDefinition(project);
          const resolvedProjectSource = this.pipelineOrchestrator.resolveProjectSourceMode(project);

          if (project.sourceMode !== resolvedProjectSource) {
            await tx.project.update({
              where: { id: projectId },
              data: { sourceMode: resolvedProjectSource },
            });
          }

          const existingPipelineJobs = await tx.job.findMany({
            where: {
              projectId,
              type: { in: PIPELINE_JOB_TYPES },
            },
            orderBy: { createdAt: 'asc' },
          });

          const activeStatuses = new Set<JobStatus>([JobStatus.PENDING, JobStatus.PROCESSING]);
          const duplicateActiveJobIds: string[] = [];
          const seenActiveStages = new Set<JobType>();
          for (const pipelineJob of existingPipelineJobs) {
            if (!activeStatuses.has(pipelineJob.status)) {
              continue;
            }
            if (seenActiveStages.has(pipelineJob.type)) {
              duplicateActiveJobIds.push(pipelineJob.id);
              continue;
            }
            seenActiveStages.add(pipelineJob.type);
          }

          if (duplicateActiveJobIds.length > 0) {
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
          }

          const canonicalPipelineJobs =
            duplicateActiveJobIds.length > 0
              ? await tx.job.findMany({
                  where: {
                    projectId,
                    type: { in: PIPELINE_JOB_TYPES },
                  },
                  orderBy: { createdAt: 'asc' },
                })
              : existingPipelineJobs;

          const hasActivePipelineJobs = canonicalPipelineJobs.some(
            (job) => job.status === JobStatus.PENDING || job.status === JobStatus.PROCESSING,
          );

          if (hasActivePipelineJobs) {
            if (project.status !== ProjectStatus.PROCESSING) {
              await tx.project.update({
                where: { id: projectId },
                data: { status: ProjectStatus.PROCESSING },
              });
            }
            return { jobs: canonicalPipelineJobs, mode: 'reused' };
          }

          if (project.status !== ProjectStatus.DRAFT) {
            this.logger.warn(
              toStructuredLog('pipeline.start.restart_non_draft', {
                projectId,
                status: project.status,
              }),
            );
          }

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

          return { jobs: createdJobs, mode: 'created' };
        },
      );

      const jobs = startResult.jobs;
      const processingJob = jobs.find((job) => job.status === JobStatus.PROCESSING);
      const firstPendingJob = jobs.find((job) => job.status === JobStatus.PENDING);

      if (startResult.mode === 'created') {
        await this.projectPipelineQualityService.clearMeta(projectId);
        const firstJob = jobs[0];
        await dispatchJob(firstJob);
        this.logger.log(
          toStructuredLog('pipeline.start.created', {
            projectId,
            firstJobType: firstJob.type,
          }),
        );
      } else if (!processingJob && firstPendingJob) {
        // Recovery path: pipeline exists but no worker is currently running.
        await dispatchJob(firstPendingJob);
        this.logger.log(
          toStructuredLog('pipeline.start.resumed', {
            projectId,
            firstPendingJobType: firstPendingJob.type,
          }),
        );
      } else {
        this.logger.log(
          toStructuredLog('pipeline.start.already_active', {
            projectId,
          }),
        );
      }

      return jobs;
    } catch (error) {
      this.logger.error(
        toStructuredLog('pipeline.start.failed', {
          projectId,
          error:
            error instanceof Error
              ? error.message
              : String(error),
        }),
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }

  async advancePipeline(
    projectId: string,
    dispatchJob: (job: Job) => Promise<void>,
  ): Promise<Job | null> {
    const jobs = await this.prisma.job.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
    });

    const decision = this.pipelineTransitionService.resolveAdvanceDecision(projectId, jobs);
    if (decision.kind === 'dispatch') {
      await dispatchJob(decision.job);
      this.logger.log(
        toStructuredLog('pipeline.advance.dispatched', {
          projectId,
          nextJobType: decision.job.type,
        }),
      );
      return decision.job;
    }

    if (decision.kind === 'wait') {
      return null;
    }

    if (decision.kind === 'complete') {
      await this.prisma.project.update({
        where: { id: projectId },
        data: { status: ProjectStatus.COMPLETED },
      });
      this.logger.log(
        toStructuredLog('pipeline.advance.completed', {
          projectId,
        }),
      );
      return null;
    }

    return null;
  }
}
