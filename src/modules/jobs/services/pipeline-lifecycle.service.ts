import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Job, JobStatus, ProjectStatus } from '@prisma/client';
import { PrismaService } from '../../prisma';
import { PipelineOrchestratorService } from './pipeline-orchestrator.service';
import { PipelineTransitionService } from './pipeline-transition.service';
import { ProjectPipelineQualityService } from './project-pipeline-quality.service';
import { PipelineStartReconciliationService } from './pipeline-start-reconciliation.service';
import { toStructuredLog } from '../../../common/utils/structured-log.util';

@Injectable()
export class PipelineLifecycleService {
  private readonly logger = new Logger(PipelineLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pipelineOrchestrator: PipelineOrchestratorService,
    private readonly pipelineTransitionService: PipelineTransitionService,
    private readonly projectPipelineQualityService: ProjectPipelineQualityService,
    private readonly startReconciliation: PipelineStartReconciliationService,
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
        async (tx) => {
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

          return this.startReconciliation.reconcile(tx, project, pipelineDefinition);
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
