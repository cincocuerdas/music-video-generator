import {
  Injectable,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma';
import { Job, JobType, JobStatus, ProjectStatus } from '@prisma/client';
import { PipelineOrchestratorService } from './services/pipeline-orchestrator.service';
import { JobDispatchService } from './services/job-dispatch.service';
import { ProjectPipelineQualityService } from './services/project-pipeline-quality.service';
import { PipelineTransitionService } from './services/pipeline-transition.service';
import { PipelineStatusService } from './services/pipeline-status.service';
import { PipelineCancellationService } from './services/pipeline-cancellation.service';
import { StyleLoraService } from './services/style-lora.service';
import {
  extractDegradedReasonCodesFromOutputData,
  extractDegradedReasonsFromOutputData,
} from './pipeline-quality.utils';
import type { PipelineStatus } from './types/pipeline-status.type';

export interface CreateJobDto {
  projectId: string;
  type: JobType;
  inputData?: Record<string, any>;
}

export interface UpdateJobDto {
  status?: JobStatus;
  progress?: number;
  currentStep?: string;
  workerId?: string;
  errorMessage?: string;
  outputData?: Record<string, any>;
}

const PIPELINE_JOB_TYPES: JobType[] = [
  JobType.YOUTUBE_DOWNLOAD,
  JobType.TRANSCRIPTION,
  JobType.ANALYZE_LYRICS,
  JobType.GENERATE_IMAGES,
  JobType.RENDER_VIDEO,
  JobType.FINALIZE,
];
const PIPELINE_JOB_TYPE_SET = new Set<JobType>(PIPELINE_JOB_TYPES);

type StartPipelineMode = 'created' | 'reused';

interface StartPipelineResult {
  jobs: Job[];
  mode: StartPipelineMode;
}

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pipelineOrchestrator: PipelineOrchestratorService,
    private readonly pipelineTransitionService: PipelineTransitionService,
    private readonly pipelineStatusService: PipelineStatusService,
    private readonly pipelineCancellationService: PipelineCancellationService,
    private readonly jobDispatchService: JobDispatchService,
    private readonly projectPipelineQualityService: ProjectPipelineQualityService,
    private readonly styleLoraService: StyleLoraService,
  ) { }

  private async assertProjectOwnership(projectId: string, userId: string): Promise<void> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, userId },
      select: { id: true },
    });

    if (!project) {
      throw new NotFoundException(`Project with id ${projectId} not found`);
    }
  }

  async createForUser(userId: string, data: CreateJobDto): Promise<Job> {
    await this.assertProjectOwnership(data.projectId, userId);
    return this.create(data);
  }

  async findOneForUser(id: string, userId: string): Promise<Job> {
    const job = await this.prisma.job.findFirst({
      where: { id, project: { userId } },
    });
    if (!job) throw new NotFoundException(`Job with id ${id} not found`);
    return job;
  }

  async updateForUser(id: string, userId: string, data: UpdateJobDto): Promise<Job> {
    const job = await this.findOneForUser(id, userId);
    return this.prisma.job.update({
      where: { id: job.id },
      data,
    });
  }

  async removeForUser(id: string, userId: string): Promise<Job> {
    const job = await this.findOneForUser(id, userId);
    return this.prisma.job.delete({
      where: { id: job.id },
    });
  }

  async startPipelineForUser(projectId: string, userId: string): Promise<Job[]> {
    await this.assertProjectOwnership(projectId, userId);
    return this.startPipeline(projectId);
  }

  async getPipelineStatusForUser(
    projectId: string,
    userId: string,
  ): Promise<PipelineStatus> {
    await this.assertProjectOwnership(projectId, userId);
    return this.getPipelineStatus(projectId);
  }

  async cancelPipelineForUser(projectId: string, userId: string): Promise<void> {
    await this.assertProjectOwnership(projectId, userId);
    await this.cancelPipeline(projectId);
  }

  async create(data: CreateJobDto): Promise<Job> {
    return this.prisma.job.create({
      data: {
        projectId: data.projectId,
        type: data.type,
        inputData: data.inputData ?? undefined,
      },
    });
  }

  async findOne(id: string): Promise<Job> {
    const job = await this.prisma.job.findUnique({
      where: { id },
    });
    if (!job) throw new NotFoundException(`Job with id ${id} not found`);
    return job;
  }

  async findByProject(projectId: string): Promise<Job[]> {
    return this.prisma.job.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
    });
  }

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

  async remove(id: string): Promise<Job> {
    const job = await this.prisma.job.findUnique({
      where: { id },
    });
    if (!job) throw new NotFoundException(`Job with id ${id} not found`);
    return this.prisma.job.delete({
      where: { id },
    });
  }

  async markAsProcessing(id: string, workerId: string): Promise<Job> {
    this.logger.log(`Marking job ${id} as PROCESSING by worker ${workerId}`);
    return this.update(id, {
      status: JobStatus.PROCESSING,
      workerId,
    });
  }

  async markAsCompleted(id: string, outputData: any): Promise<Job> {
    this.logger.log(`Marking job ${id} as COMPLETED`);
    const completedJob = await this.update(id, {
      status: JobStatus.COMPLETED,
      progress: 100,
      outputData,
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
    this.logger.error(`Marking job ${id} as FAILED: ${error}`);
    const failedJob = await this.prisma.$transaction(async (tx) => {
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

    return failedJob;
  }

  async updateProgress(id: string, progress: number, currentStep?: string): Promise<Job> {
    return this.update(id, {
      progress,
      currentStep,
    });
  }

  async startPipeline(projectId: string): Promise<Job[]> {
    this.logger.log(`Intentando iniciar pipeline para proyecto: ${projectId}`);
    try {
      const startResult = await this.prisma.$transaction(async (tx): Promise<StartPipelineResult> => {
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

        const hasActivePipelineJobs = canonicalPipelineJobs.some((job) =>
          job.status === JobStatus.PENDING || job.status === JobStatus.PROCESSING,
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
      });

      const jobs = startResult.jobs;
      const processingJob = jobs.find((job) => job.status === JobStatus.PROCESSING);
      const firstPendingJob = jobs.find((job) => job.status === JobStatus.PENDING);

      if (startResult.mode === 'created') {
        await this.projectPipelineQualityService.clearMeta(projectId);
        const firstJob = jobs[0];
        await this.dispatchJob(firstJob);
        this.logger.log(`Pipeline started successfully for project ${projectId}`);
      } else if (!processingJob && firstPendingJob) {
        // Recovery path: pipeline exists but no worker is currently running.
        await this.dispatchJob(firstPendingJob);
        this.logger.log(
          `Pipeline already existed for project ${projectId}; resumed from ${firstPendingJob.type}`,
        );
      } else {
        this.logger.log(`Pipeline already active for project ${projectId}; returning current jobs`);
      }

      return jobs;

    } catch (error) {
      this.logger.error('--- ERROR CRÍTICO EN START PIPELINE ---');
      this.logger.error(error);
      throw error;
    }
  }

  async advancePipeline(projectId: string): Promise<Job | null> {
    const jobs = await this.prisma.job.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
    });

    const decision = this.pipelineTransitionService.resolveAdvanceDecision(projectId, jobs);
    if (decision.kind === 'dispatch') {
      await this.dispatchJob(decision.job);
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

  async getPipelineStatus(projectId: string): Promise<PipelineStatus> {
    return this.pipelineStatusService.getPipelineStatus(projectId);
  }

  async cancelPipeline(projectId: string): Promise<void> {
    await this.pipelineCancellationService.cancelPipeline(projectId);
  }

  async triggerStyleLoraTraining(
    projectId: string,
    style: string,
    likesCount: number,
  ): Promise<Job | null> {
    return this.styleLoraService.triggerStyleLoraTraining(projectId, style, likesCount);
  }

  async updateStyleLoraConfig(
    style: string,
    payload: { loraFilename: string; loraPath: string; likesUsed?: number },
  ): Promise<void> {
    return this.styleLoraService.updateStyleLoraConfig(style, payload);
  }

  private async dispatchJob(job: Job): Promise<void> {
    await this.jobDispatchService.dispatch(job, async (finalizeJob) => {
      await this.markAsCompleted(finalizeJob.id, { finalized: true });
      await this.advancePipeline(finalizeJob.projectId);
    });
  }

  async dispatchPipelineJob(job: Job): Promise<void> {
    await this.dispatchJob(job);
  }
}
