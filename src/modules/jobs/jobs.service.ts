import { Injectable, NotFoundException, Logger, BadRequestException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { JobsOptions, Queue } from 'bullmq';
import { promises as fs } from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma';
import { Job, JobType, JobStatus, ProjectStatus, Prisma } from '@prisma/client';
import { QUEUE_NAMES } from '../queue';
import {
  deriveProjectPipelineStatus,
  extractDegradedReasonCodesFromOutputData,
  extractDegradedReasonsFromOutputData,
  summarizePipelineQuality,
} from './pipeline-quality.utils';

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

export interface PipelineStatus {
  projectId: string;
  projectStatus: ProjectStatus;
  pipelineStatus:
    | 'draft'
    | 'processing'
    | 'success'
    | 'degraded'
    | 'failed'
    | 'cancelled';
  degraded: boolean;
  degradedReasons: string[];
  degradedReasonCodes: string[];
  jobs: {
    type: JobType;
    status: JobStatus;
    progress: number;
    currentStep: string | null;
    errorMessage: string | null;
  }[];
  currentJob: JobType | null;
  overallProgress: number;
}

interface StyleLoraConfigEntry {
  loraFilename: string;
  loraPath: string;
  updatedAt: string;
  likesUsed?: number;
}

const FULL_PIPELINE_ORDER: JobType[] = [
  JobType.YOUTUBE_DOWNLOAD,
  JobType.TRANSCRIPTION,
  JobType.ANALYZE_LYRICS,
  JobType.GENERATE_IMAGES,
  JobType.RENDER_VIDEO,
  JobType.FINALIZE,
];
const PIPELINE_JOB_TYPES: JobType[] = [
  JobType.YOUTUBE_DOWNLOAD,
  JobType.TRANSCRIPTION,
  JobType.ANALYZE_LYRICS,
  JobType.GENERATE_IMAGES,
  JobType.RENDER_VIDEO,
  JobType.FINALIZE,
];
const PIPELINE_JOB_TYPE_SET = new Set<JobType>(PIPELINE_JOB_TYPES);
type PipelineSourceMode = 'youtube' | 'audio' | 'lyrics';
interface PipelineDefinition {
  source: PipelineSourceMode;
  order: JobType[];
}

const RETRY_ENV_CONFIG: Partial<
  Record<JobType, { attemptsEnv: string; attemptsDefault: number; delayEnv: string; delayDefault: number }>
> = {
  [JobType.YOUTUBE_DOWNLOAD]: {
    attemptsEnv: 'JOB_RETRY_ATTEMPTS_YOUTUBE_DOWNLOAD',
    attemptsDefault: 2,
    delayEnv: 'JOB_RETRY_DELAY_MS_YOUTUBE_DOWNLOAD',
    delayDefault: 15_000,
  },
  [JobType.TRANSCRIPTION]: {
    attemptsEnv: 'JOB_RETRY_ATTEMPTS_TRANSCRIPTION',
    attemptsDefault: 2,
    delayEnv: 'JOB_RETRY_DELAY_MS_TRANSCRIPTION',
    delayDefault: 20_000,
  },
  [JobType.ANALYZE_LYRICS]: {
    attemptsEnv: 'JOB_RETRY_ATTEMPTS_ANALYZE_LYRICS',
    attemptsDefault: 3,
    delayEnv: 'JOB_RETRY_DELAY_MS_ANALYZE_LYRICS',
    delayDefault: 10_000,
  },
  [JobType.GENERATE_IMAGES]: {
    attemptsEnv: 'JOB_RETRY_ATTEMPTS_GENERATE_IMAGES',
    attemptsDefault: 3,
    delayEnv: 'JOB_RETRY_DELAY_MS_GENERATE_IMAGES',
    delayDefault: 15_000,
  },
  [JobType.RENDER_VIDEO]: {
    attemptsEnv: 'JOB_RETRY_ATTEMPTS_RENDER_VIDEO',
    attemptsDefault: 2,
    delayEnv: 'JOB_RETRY_DELAY_MS_RENDER_VIDEO',
    delayDefault: 20_000,
  },
  [JobType.TRAIN_LORA]: {
    attemptsEnv: 'JOB_RETRY_ATTEMPTS_TRAIN_LORA',
    attemptsDefault: 2,
    delayEnv: 'JOB_RETRY_DELAY_MS_TRAIN_LORA',
    delayDefault: 60_000,
  },
};

type StartPipelineMode = 'created' | 'reused';

interface StartPipelineResult {
  jobs: Job[];
  mode: StartPipelineMode;
}

export interface DeadLetterEntry {
  sourceQueue: string;
  projectId: string;
  jobId: string;
  jobType: JobType;
  correlationId: string;
  message: string;
  attemptsMade: number;
  maxAttempts: number;
  retryable: boolean;
  category: 'transient' | 'permanent' | 'unknown';
  payload?: Record<string, unknown>;
  capturedAt: string;
}

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);
  private readonly generationConfigPath = path.join(
    process.cwd(),
    'storage',
    'generation-config.json',
  );

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUE_NAMES.YOUTUBE_DOWNLOAD)
    private readonly youtubeDownloadQueue: Queue,
    @InjectQueue(QUEUE_NAMES.TRANSCRIPTION)
    private readonly transcriptionQueue: Queue,
    @InjectQueue(QUEUE_NAMES.ANALYSIS)
    private readonly analysisQueue: Queue,
    @InjectQueue(QUEUE_NAMES.IMAGE_GENERATION)
    private readonly imageGenerationQueue: Queue,
    @InjectQueue(QUEUE_NAMES.VIDEO_RENDER)
    private readonly videoRenderQueue: Queue,
    @InjectQueue(QUEUE_NAMES.TRAIN_LORA)
    private readonly trainLoraQueue: Queue,
    @InjectQueue(QUEUE_NAMES.DEAD_LETTER)
    private readonly deadLetterQueue: Queue,
  ) { }

  private parsePositiveIntEnv(key: string, fallback: number): number {
    const raw = process.env[key];
    if (!raw) {
      return fallback;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
  }

  private resolveProjectSourceMode(project: {
    youtubeUrl: string | null;
    audioUrl: string | null;
    lyrics: string | null;
  }): PipelineSourceMode | 'unknown' {
    const youtubeUrl = (project.youtubeUrl || '').trim();
    const audioUrl = (project.audioUrl || '').trim();
    const lyrics = (project.lyrics || '').trim();

    if (youtubeUrl) {
      return 'youtube';
    }
    if (audioUrl && !lyrics) {
      return 'audio';
    }
    if (lyrics || audioUrl) {
      return 'lyrics';
    }
    return 'unknown';
  }

  private ensureProviderPreflight(): void {
    const imageProvider = (process.env.IMAGE_PROVIDER || 'comfyui').trim().toLowerCase();
    const llmProvider = (process.env.LLM_PROVIDER || 'gemini').trim().toLowerCase();

    if (imageProvider === 'comfyui' && !(process.env.COMFYUI_URL || '').trim()) {
      throw new BadRequestException(
        'Pipeline preflight failed: COMFYUI_URL is missing while IMAGE_PROVIDER=comfyui.',
      );
    }

    if (imageProvider === 'replicate' && !(process.env.REPLICATE_API_TOKEN || '').trim()) {
      throw new BadRequestException(
        'Pipeline preflight failed: REPLICATE_API_TOKEN is missing while IMAGE_PROVIDER=replicate.',
      );
    }

    if (llmProvider === 'gemini' && !(process.env.GEMINI_API_KEY || '').trim()) {
      throw new BadRequestException(
        'Pipeline preflight failed: GEMINI_API_KEY is missing while LLM_PROVIDER=gemini.',
      );
    }
  }

  private ensureProjectPreflight(project: {
    youtubeUrl: string | null;
    audioUrl: string | null;
    lyrics: string | null;
  }): void {
    const youtubeUrl = (project.youtubeUrl || '').trim();
    const audioUrl = (project.audioUrl || '').trim();
    const lyrics = (project.lyrics || '').trim();

    if (!youtubeUrl && !audioUrl && !lyrics) {
      throw new BadRequestException(
        'Pipeline preflight failed: project has no source input (youtubeUrl/audioUrl/lyrics).',
      );
    }
  }

  private buildPipelineDefinition(project: {
    youtubeUrl: string | null;
    audioUrl: string | null;
    lyrics: string | null;
  }): PipelineDefinition {
    const youtubeUrl = (project.youtubeUrl || '').trim();
    const audioUrl = (project.audioUrl || '').trim();
    const lyrics = (project.lyrics || '').trim();

    if (youtubeUrl) {
      return {
        source: 'youtube',
        order: [...FULL_PIPELINE_ORDER],
      };
    }

    if (audioUrl && !lyrics) {
      return {
        source: 'audio',
        order: [
          JobType.TRANSCRIPTION,
          JobType.ANALYZE_LYRICS,
          JobType.GENERATE_IMAGES,
          JobType.RENDER_VIDEO,
          JobType.FINALIZE,
        ],
      };
    }

    return {
      source: 'lyrics',
      order: [
        JobType.ANALYZE_LYRICS,
        JobType.GENERATE_IMAGES,
        JobType.RENDER_VIDEO,
        JobType.FINALIZE,
      ],
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
      await this.appendProjectPipelineQualityMeta(
        completedJob.projectId,
        degradedReasons,
        degradedReasonCodes,
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

        this.ensureProviderPreflight();
        this.ensureProjectPreflight(project);
        const pipelineDefinition = this.buildPipelineDefinition(project);
        const resolvedProjectSource = this.resolveProjectSourceMode(project);

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

        const hasActivePipelineJobs = existingPipelineJobs.some((job) =>
          job.status === JobStatus.PENDING || job.status === JobStatus.PROCESSING,
        );

        if (hasActivePipelineJobs) {
          if (project.status !== ProjectStatus.PROCESSING) {
            await tx.project.update({
              where: { id: projectId },
              data: { status: ProjectStatus.PROCESSING },
            });
          }
          return { jobs: existingPipelineJobs, mode: 'reused' };
        }

        if (project.status !== ProjectStatus.DRAFT) {
          this.logger.warn(
            `El proyecto no estaba en DRAFT, estaba en ${project.status}. Reiniciando...`,
          );
        }

        await tx.job.deleteMany({ where: { projectId } });

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
        await this.clearProjectPipelineQualityMeta(projectId);
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

    if (jobs.length === 0) {
      throw new NotFoundException(`No jobs found for project ${projectId}`);
    }

    const pipelineJobs = jobs.filter((job) => PIPELINE_JOB_TYPE_SET.has(job.type));
    if (pipelineJobs.length === 0) {
      throw new NotFoundException(`No pipeline jobs found for project ${projectId}`);
    }

    const nextJob = pipelineJobs.find((job) => job.status === JobStatus.PENDING);
    if (nextJob) {
      await this.dispatchJob(nextJob);
      this.logger.log(`Advanced pipeline to ${nextJob.type} for project ${projectId}`);
      return nextJob;
    }

    const hasRunning = pipelineJobs.some((job) => job.status === JobStatus.PROCESSING);
    if (hasRunning) {
      return null;
    }

    const allCompleted = pipelineJobs.every((job) => job.status === JobStatus.COMPLETED);
    if (allCompleted) {
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
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });

    if (!project) throw new NotFoundException(`Project with id ${projectId} not found`);

    const jobs = await this.prisma.job.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
    });

    const currentJob = jobs.find((job) => job.status === JobStatus.PROCESSING);
    const pipelineJobs = jobs.filter((job) => PIPELINE_JOB_TYPE_SET.has(job.type));
    const quality = summarizePipelineQuality(pipelineJobs);
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

    const overallProgress =
      pipelineJobs.length > 0
        ? Math.round(normalizedPipelineProgress / pipelineJobs.length)
        : 0;

    return {
      projectId,
      projectStatus: project.status,
      pipelineStatus: deriveProjectPipelineStatus(project.status, quality),
      degraded: quality.degraded,
      degradedReasons: quality.degradedReasons,
      degradedReasonCodes: quality.degradedReasonCodes,
      jobs: jobs.map((job) => ({
        type: job.type,
        status: job.status,
        progress: job.progress,
        currentStep: job.currentStep,
        errorMessage: job.errorMessage,
      })),
      currentJob: currentJob?.type ?? null,
      overallProgress,
    };
  }

  private async appendProjectPipelineQualityMeta(
    projectId: string,
    degradedReasons: string[],
    degradedReasonCodes: string[] = [],
  ): Promise<void> {
    if (!degradedReasons.length && !degradedReasonCodes.length) {
      return;
    }

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { analysisResult: true },
    });
    if (!project) {
      return;
    }

    const analysisResult =
      project.analysisResult &&
      typeof project.analysisResult === 'object' &&
      !Array.isArray(project.analysisResult)
        ? { ...(project.analysisResult as Record<string, unknown>) }
        : {};

    const existingMeta =
      analysisResult._pipelineQuality &&
      typeof analysisResult._pipelineQuality === 'object' &&
      !Array.isArray(analysisResult._pipelineQuality)
        ? (analysisResult._pipelineQuality as Record<string, unknown>)
        : {};
    const existingReasons = Array.isArray(existingMeta.degradedReasons)
      ? existingMeta.degradedReasons
          .map((reason) => (typeof reason === 'string' ? reason.trim() : ''))
          .filter((reason) => reason.length > 0)
      : [];
    const mergedReasons = Array.from(new Set([...existingReasons, ...degradedReasons])).slice(0, 50);
    const existingReasonCodes = Array.isArray(existingMeta.degradedReasonCodes)
      ? existingMeta.degradedReasonCodes
          .map((reason) => (typeof reason === 'string' ? reason.trim() : ''))
          .filter((reason) => reason.length > 0)
      : [];
    const mergedReasonCodes = Array.from(
      new Set([...existingReasonCodes, ...degradedReasonCodes]),
    ).slice(0, 50);

    analysisResult._pipelineQuality = {
      ...existingMeta,
      degraded: true,
      degradedReasons: mergedReasons,
      degradedReasonCodes: mergedReasonCodes,
      updatedAt: new Date().toISOString(),
    };

    await this.prisma.project.update({
      where: { id: projectId },
      data: { analysisResult: analysisResult as Prisma.InputJsonValue },
    });
  }

  private async clearProjectPipelineQualityMeta(projectId: string): Promise<void> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { analysisResult: true },
    });
    if (!project?.analysisResult || typeof project.analysisResult !== 'object' || Array.isArray(project.analysisResult)) {
      return;
    }

    const analysisResult = { ...(project.analysisResult as Record<string, unknown>) };
    if (!Object.prototype.hasOwnProperty.call(analysisResult, '_pipelineQuality')) {
      return;
    }

    delete analysisResult._pipelineQuality;
    await this.prisma.project.update({
      where: { id: projectId },
      data: { analysisResult: analysisResult as Prisma.InputJsonValue },
    });
  }

  async cancelPipeline(projectId: string): Promise<void> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });

    if (!project) throw new NotFoundException(`Project with id ${projectId} not found`);

    await this.prisma.$transaction([
      this.prisma.job.updateMany({
        where: {
          projectId,
          status: { in: [JobStatus.PENDING, JobStatus.PROCESSING] },
        },
        data: { status: JobStatus.CANCELLED },
      }),
      this.prisma.project.update({
        where: { id: projectId },
        data: { status: ProjectStatus.CANCELLED },
      }),
    ]);
    this.logger.log(`Pipeline cancelled for project ${projectId}`);
  }

  async enqueueDeadLetter(entry: DeadLetterEntry): Promise<void> {
    await this.deadLetterQueue.add('dead-letter', entry, {
      removeOnComplete: 500,
      removeOnFail: 1000,
    });
  }

  async listDeadLettersForUser(userId: string, limit = 25): Promise<Record<string, unknown>> {
    const safeLimit = Math.max(1, Math.min(limit, 100));
    const jobs = await this.deadLetterQueue.getJobs(
      ['waiting', 'active', 'delayed', 'completed', 'failed'],
      0,
      safeLimit - 1,
      true,
    );

    const projectIds = Array.from(
      new Set(
        jobs
          .map((job) =>
            job.data && typeof job.data === 'object'
              ? (job.data as Record<string, unknown>).projectId
              : null,
          )
          .filter((value): value is string => typeof value === 'string'),
      ),
    );

    const ownedProjects = await this.prisma.project.findMany({
      where: { userId, id: { in: projectIds } },
      select: { id: true },
    });
    const ownedProjectIds = new Set(ownedProjects.map((project) => project.id));

    const ownedItems = jobs.filter((job) => {
      const projectId =
        job.data && typeof job.data === 'object'
          ? (job.data as Record<string, unknown>).projectId
          : null;
      return typeof projectId === 'string' && ownedProjectIds.has(projectId);
    });

    const items = await Promise.all(
      ownedItems.map(async (job) => ({
        deadLetterId: String(job.id),
        status: await job.getState(),
        name: job.name,
        attemptsMade: job.attemptsMade,
        failedReason: job.failedReason || null,
        timestamp: job.timestamp,
        data: job.data,
      })),
    );

    return {
      total: items.length,
      items,
    };
  }

  async replayDeadLetterForUser(deadLetterId: string, userId: string): Promise<Record<string, unknown>> {
    const deadLetterJob = await this.deadLetterQueue.getJob(deadLetterId);
    if (!deadLetterJob) {
      throw new NotFoundException(`Dead-letter job ${deadLetterId} not found`);
    }

    const data =
      deadLetterJob.data && typeof deadLetterJob.data === 'object'
        ? (deadLetterJob.data as Record<string, unknown>)
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

    await this.dispatchJob(replayed);
    await deadLetterJob.updateData({
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

  async triggerStyleLoraTraining(
    projectId: string,
    style: string,
    likesCount: number,
  ): Promise<Job | null> {
    const normalizedStyle = this.normalizeStyle(style);
    if (!normalizedStyle || likesCount < 50) {
      return null;
    }

    const activeJob = await this.prisma.job.findFirst({
      where: {
        type: JobType.TRAIN_LORA,
        status: { in: [JobStatus.PENDING, JobStatus.PROCESSING] },
        inputData: {
          path: ['style'],
          equals: normalizedStyle,
        },
      },
      select: { id: true },
    });

    if (activeJob) {
      this.logger.log(
        `Skipping TRAIN_LORA enqueue for style "${normalizedStyle}": active job ${activeJob.id} already exists`,
      );
      return null;
    }

    const latestCompleted = await this.prisma.job.findFirst({
      where: {
        type: JobType.TRAIN_LORA,
        status: JobStatus.COMPLETED,
        inputData: {
          path: ['style'],
          equals: normalizedStyle,
        },
      },
      orderBy: { createdAt: 'desc' },
      select: { outputData: true },
    });

    const lastLikesUsed = this.extractLikesUsed(latestCompleted?.outputData);
    if (likesCount < lastLikesUsed + 50) {
      this.logger.log(
        `Skipping TRAIN_LORA for style "${normalizedStyle}": likes=${likesCount}, lastTrainingLikes=${lastLikesUsed}`,
      );
      return null;
    }

    const trainJob = await this.create({
      projectId,
      type: JobType.TRAIN_LORA,
      inputData: {
        style: normalizedStyle,
        likesCount,
        triggeredAt: new Date().toISOString(),
      },
    });

    await this.dispatchJob(trainJob);
    this.logger.log(
      `TRAIN_LORA queued for style "${normalizedStyle}" (likes=${likesCount}) via project ${projectId}`,
    );

    return trainJob;
  }

  async updateStyleLoraConfig(
    style: string,
    payload: { loraFilename: string; loraPath: string; likesUsed?: number },
  ): Promise<void> {
    const normalizedStyle = this.normalizeStyle(style);
    if (!normalizedStyle) {
      return;
    }

    const config = await this.readGenerationConfig();
    const styleLoras = (config.styleLoras ?? {}) as Record<string, StyleLoraConfigEntry>;

    styleLoras[normalizedStyle] = {
      loraFilename: payload.loraFilename,
      loraPath: payload.loraPath,
      likesUsed: payload.likesUsed,
      updatedAt: new Date().toISOString(),
    };

    config.styleLoras = styleLoras;
    await this.writeGenerationConfig(config);

    this.logger.log(
      `Generation config updated for style "${normalizedStyle}" with LoRA ${payload.loraFilename}`,
    );
  }

  private extractLikesUsed(outputData: unknown): number {
    if (!outputData || typeof outputData !== 'object') {
      return 0;
    }

    const likes = (outputData as Record<string, unknown>).likesCount;
    return typeof likes === 'number' && Number.isFinite(likes) ? likes : 0;
  }

  private normalizeStyle(style: string): string {
    return style?.trim().toLowerCase() || '';
  }

  private async readGenerationConfig(): Promise<Record<string, unknown>> {
    try {
      const raw = await fs.readFile(this.generationConfigPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
      return {};
    } catch {
      return {};
    }
  }

  private async writeGenerationConfig(config: Record<string, unknown>): Promise<void> {
    const dirPath = path.dirname(this.generationConfigPath);
    await fs.mkdir(dirPath, { recursive: true });
    await fs.writeFile(this.generationConfigPath, JSON.stringify(config, null, 2), 'utf-8');
  }

  private getQueueJobOptions(type: JobType, jobId: string): JobsOptions {
    const envConfig = RETRY_ENV_CONFIG[type];
    const policy = envConfig
      ? {
          attempts: this.parsePositiveIntEnv(envConfig.attemptsEnv, envConfig.attemptsDefault),
          delayMs: this.parsePositiveIntEnv(envConfig.delayEnv, envConfig.delayDefault),
        }
      : { attempts: 1, delayMs: 0 };
    return {
      jobId,
      attempts: policy.attempts,
      backoff:
        policy.attempts > 1
          ? {
              type: 'exponential',
              delay: policy.delayMs,
            }
          : undefined,
      removeOnComplete: 200,
      removeOnFail: 500,
    };
  }

  private async dispatchJob(job: Job): Promise<void> {
    const inputData =
      job.inputData && typeof job.inputData === 'object'
        ? (job.inputData as Record<string, unknown>)
        : {};
    const style = inputData.style;
    const correlationId =
      typeof inputData.correlationId === 'string' && inputData.correlationId.trim()
        ? inputData.correlationId.trim()
        : `${job.projectId}:${job.id}:${randomUUID().slice(0, 8)}`;

    const payload = {
      jobId: job.id,
      projectId: job.projectId,
      style: typeof style === 'string' ? style : undefined,
      correlationId,
    };
    const queueOptions = this.getQueueJobOptions(job.type, job.id);

    switch (job.type) {
      case JobType.YOUTUBE_DOWNLOAD:
        await this.youtubeDownloadQueue.add('process', payload, queueOptions);
        break;
      case JobType.TRANSCRIPTION:
        await this.transcriptionQueue.add('process', payload, queueOptions);
        break;
      case JobType.ANALYZE_LYRICS:
        await this.analysisQueue.add('process', payload, queueOptions);
        break;
      case JobType.GENERATE_IMAGES:
        await this.imageGenerationQueue.add('process', payload, queueOptions);
        break;
      case JobType.RENDER_VIDEO:
        await this.videoRenderQueue.add('process', payload, queueOptions);
        break;
      case JobType.TRAIN_LORA:
        await this.trainLoraQueue.add('process', payload, queueOptions);
        break;
      case JobType.FINALIZE:
        await this.markAsCompleted(job.id, { finalized: true });
        await this.advancePipeline(job.projectId);
        break;
    }
  }
}
