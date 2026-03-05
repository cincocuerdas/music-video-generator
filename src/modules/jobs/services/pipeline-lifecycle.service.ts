import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Job, JobStatus, JobType, ProjectStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma';
import { PIPELINE_JOB_TYPES } from '../pipeline.constants';
import { PipelineOrchestratorService } from './pipeline-orchestrator.service';
import { PipelineTransitionService } from './pipeline-transition.service';
import { ProjectPipelineQualityService } from './project-pipeline-quality.service';

type StartPipelineMode = 'created' | 'reused';

interface StartPipelineResult {
  jobs: Job[];
  mode: StartPipelineMode;
}

@Injectable()
export class PipelineLifecycleService {
  private readonly logger = new Logger(PipelineLifecycleService.name);

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
    this.logger.log(`Intentando iniciar pipeline para proyecto: ${projectId}`);
    try {
      const startResult = await this.prisma.$transaction(
        async (tx): Promise<StartPipelineResult> => {
          // Prevent concurrent start requests from creating duplicate pipelines.
          await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${projectId}::uuid FOR UPDATE`;

          const project = await tx.project.findUnique({
            where: { id: projectId },
            select: {
              id: true,
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
              `El proyecto no estaba en DRAFT, estaba en ${project.status}. Reiniciando...`,
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
          for (let i = 0; i < pipelineDefinition.order.length; i++) {
            const job = await tx.job.create({
              data: {
                projectId,
                type: pipelineDefinition.order[i],
                status: JobStatus.PENDING,
                inputData: {
                  correlationId: pipelineCorrelationId,
                  sourceMode: pipelineDefinition.source,
                },
              },
            });
            createdJobs.push(job);
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
        this.logger.log(`Pipeline started successfully for project ${projectId}`);
      } else if (!processingJob && firstPendingJob) {
        // Recovery path: pipeline exists but no worker is currently running.
        await dispatchJob(firstPendingJob);
        this.logger.log(
          `Pipeline already existed for project ${projectId}; resumed from ${firstPendingJob.type}`,
        );
      } else {
        this.logger.log(`Pipeline already active for project ${projectId}; returning current jobs`);
      }

      return jobs;
    } catch (error) {
      this.logger.error('--- ERROR CRITICO EN START PIPELINE ---');
      this.logger.error(error);
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
      this.logger.log(`Advanced pipeline to ${decision.job.type} for project ${projectId}`);
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
      this.logger.log(`Pipeline completed for project ${projectId}`);
      return null;
    }

    return null;
  }
}
