import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma';
import { JobsService } from '../jobs/jobs.service';
import { isValidYoutubeUrl } from '../../common/constants';
import {
  CreateProjectDto,
  UpdateProjectDto,
  StartGenerationDto,
  CreateFeedbackDto,
} from './dto';
import {
  deriveProjectPipelineStatus,
  summarizePipelineQuality,
} from '../jobs/pipeline-quality.utils';
import { ProjectFeedbackService } from './services/project-feedback.service';
import { PromptOptimizationService } from './services/prompt-optimization.service';
import { LiveSteeringService } from './services/live-steering.service';

type ProjectSourceMode = 'youtube' | 'audio' | 'lyrics' | 'unknown';

@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);

  private resolveProjectSourceMode(projectLike: {
    youtubeUrl?: string | null;
    audioUrl?: string | null;
    lyrics?: string | null;
  }): ProjectSourceMode {
    const youtubeUrl = (projectLike.youtubeUrl || '').trim();
    const audioUrl = (projectLike.audioUrl || '').trim();
    const lyrics = (projectLike.lyrics || '').trim();

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

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobsService: JobsService,
    private readonly feedbackService: ProjectFeedbackService,
    private readonly promptOptimization: PromptOptimizationService,
    private readonly liveSteering: LiveSteeringService,
  ) {}

  private async assertProjectOwnership(projectId: string, userId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, userId },
      select: { id: true },
    });

    if (!project) {
      throw new NotFoundException('Project not found');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PROJECT CRUD
  // ═══════════════════════════════════════════════════════════════════════════

  async create(userId: string, createProjectDto: CreateProjectDto) {
    this.logger.log(`Attempting to create project for user ${userId}: ${JSON.stringify(createProjectDto)}`);

    if (createProjectDto.youtubeUrl && !isValidYoutubeUrl(createProjectDto.youtubeUrl)) {
      this.logger.warn(`Rejected invalid YouTube URL: ${createProjectDto.youtubeUrl}`);
      throw new BadRequestException('Invalid YouTube URL');
    }

    return this.prisma.project.create({
      data: {
        userId,
        title: createProjectDto.title,
        youtubeUrl: createProjectDto.youtubeUrl,
        lyrics: createProjectDto.lyrics,
        sourceMode: this.resolveProjectSourceMode({
          youtubeUrl: createProjectDto.youtubeUrl,
          lyrics: createProjectDto.lyrics,
        }),
        visualStyle: createProjectDto.visualStyle,
        colorPalette: createProjectDto.colorPalette ?? [],
        aspectRatio: createProjectDto.aspectRatio ?? '16:9',
      },
    });
  }

  async findAll(userId: string, page: number, limit: number) {
    const skip = (page - 1) * limit;

    const [projects, total] = await Promise.all([
      this.prisma.project.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.project.count({ where: { userId } }),
    ]);

    return {
      data: projects,
      total,
      page,
      limit,
    };
  }

  async findOne(id: string, userId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id, userId },
      include: {
        jobs: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    const quality = summarizePipelineQuality(project.jobs);
    return {
      ...project,
      pipelineStatus: deriveProjectPipelineStatus(project.status, quality),
      degraded: quality.degraded,
      degradedReasons: quality.degradedReasons,
      degradedReasonCodes: quality.degradedReasonCodes,
    };
  }

  async update(id: string, userId: string, updateProjectDto: UpdateProjectDto) {
    const project = await this.prisma.project.findFirst({
      where: { id, userId },
    });

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    return this.prisma.project.update({
      where: { id },
      data: {
        ...updateProjectDto,
        sourceMode: this.resolveProjectSourceMode({
          youtubeUrl: project.youtubeUrl,
          audioUrl: project.audioUrl,
          lyrics: updateProjectDto.lyrics ?? project.lyrics,
        }),
      },
    });
  }

  async remove(id: string, userId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id, userId },
    });

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    return this.prisma.project.delete({ where: { id } });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // AUDIO UPLOAD
  // ═══════════════════════════════════════════════════════════════════════════


  // ═══════════════════════════════════════════════════════════════════════════
  // VERSES
  // ═══════════════════════════════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════════════════════════════
  // GENERATION
  // ═══════════════════════════════════════════════════════════════════════════

  async startGeneration(id: string, userId: string, dto: StartGenerationDto) {
    if (dto.youtubeUrl && !isValidYoutubeUrl(dto.youtubeUrl)) {
      this.logger.warn(`Rejected invalid YouTube URL: ${dto.youtubeUrl}`);
      throw new BadRequestException('Invalid YouTube URL');
    }

    // Verify project exists and belongs to user
    const project = await this.prisma.project.findFirst({
      where: { id, userId },
    });

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    // Update project with youtubeUrl if provided
    if (dto.youtubeUrl) {
      await this.prisma.project.update({
        where: { id },
        data: {
          youtubeUrl: dto.youtubeUrl,
          sourceMode: this.resolveProjectSourceMode({
            youtubeUrl: dto.youtubeUrl,
            audioUrl: project.audioUrl,
            lyrics: project.lyrics,
          }),
          visualStyle: dto.visualStyle || project.visualStyle || 'cinematic',
        },
      });
    }

    // Start the job pipeline
    const jobs = await this.jobsService.startPipeline(id);

    return {
      projectId: id,
      message: 'Generation started',
      totalJobs: jobs.length,
      jobs: jobs.map(job => ({
        id: job.id,
        type: job.type,
        status: job.status,
      })),
    };
  }

  async getStatus(id: string, userId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id, userId },
      include: {
        jobs: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            type: true,
            status: true,
            progress: true,
            currentStep: true,
            errorMessage: true,
            outputData: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
    });

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    // Calculate overall progress from core pipeline jobs only.
    const jobs = project.jobs;
    const pipelineJobTypes = new Set([
      'YOUTUBE_DOWNLOAD',
      'TRANSCRIPTION',
      'ANALYZE_LYRICS',
      'GENERATE_IMAGES',
      'RENDER_VIDEO',
      'FINALIZE',
    ]);
    const relevantJobs = jobs.filter(job => pipelineJobTypes.has(String(job.type)));
    const progressJobs = relevantJobs.length > 0 ? relevantJobs : jobs;
    const totalJobs = progressJobs.length;
    const overallProgress =
      totalJobs > 0
        ? Math.round(
            progressJobs.reduce((sum, job) => {
              if (String(job.status) === 'COMPLETED') {
                return sum + 100;
              }
              if (String(job.status) === 'PROCESSING') {
                const safeProgress = Math.max(0, Math.min(100, job.progress || 0));
                return sum + safeProgress;
              }
              return sum;
            }, 0) / totalJobs,
          )
        : 0;
    const quality = summarizePipelineQuality(jobs);

    return {
      projectId: project.id,
      status: project.status,
      pipelineStatus: deriveProjectPipelineStatus(project.status, quality),
      degraded: quality.degraded,
      degradedReasons: quality.degradedReasons,
      degradedReasonCodes: quality.degradedReasonCodes,
      overallProgress,
      jobs: jobs.map(job => ({
        id: job.id,
        type: job.type,
        status: job.status,
        progress: job.progress,
        currentStep: job.currentStep,
        errorMessage: job.errorMessage,
      })),
    };
  }

  async cancelGeneration(id: string, userId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id, userId },
    });

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    await this.jobsService.cancelPipeline(id);

    return {
      success: true,
      message: 'Generation cancelled',
      projectId: id,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // VIDEO OUTPUT
  // ═══════════════════════════════════════════════════════════════════════════

  async getVideo(id: string, userId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id, userId },
      select: {
        id: true,
        status: true,
        videoUrl: true,
        thumbnailUrl: true,
        jobs: {
          select: {
            type: true,
            status: true,
            outputData: true,
          },
        },
      },
    });

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    const quality = summarizePipelineQuality(project.jobs);
    return {
      projectId: project.id,
      status: project.status,
      pipelineStatus: deriveProjectPipelineStatus(project.status, quality),
      degraded: quality.degraded,
      degradedReasons: quality.degradedReasons,
      degradedReasonCodes: quality.degradedReasonCodes,
      videoUrl: project.videoUrl,
      thumbnailUrl: project.thumbnailUrl,
    };
  }

  async getDownloadUrl(id: string, userId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id, userId },
      select: { id: true, videoUrl: true },
    });

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    if (!project.videoUrl) {
      throw new BadRequestException('Project does not have a rendered video yet');
    }

    return {
      projectId: project.id,
      downloadUrl: project.videoUrl,
      expiresAt: null,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // AI FEEDBACK (delegates to ProjectFeedbackService)
  // ═══════════════════════════════════════════════════════════════════════════

  async addFeedback(projectId: string, userId: string, dto: CreateFeedbackDto) {
    await this.assertProjectOwnership(projectId, userId);
    return this.feedbackService.addFeedback(projectId, dto);
  }

  async getFeedback(projectId: string, userId: string) {
    await this.assertProjectOwnership(projectId, userId);
    return this.feedbackService.getFeedback(projectId);
  }

  async getFeedbackStats(style?: string) {
    return this.feedbackService.getFeedbackStats(style);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // AI PROMPT OPTIMIZATION (delegates to PromptOptimizationService)
  // ═══════════════════════════════════════════════════════════════════════════

  async getPromptOptimization(projectId: string, userId?: string, currentPrompt?: string) {
    return this.promptOptimization.getPromptOptimization(projectId, userId, currentPrompt);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LIVE STEERING (delegates to LiveSteeringService)
  // ═══════════════════════════════════════════════════════════════════════════

  async saveLiveSignal(
    projectId: string,
    userId: string,
    signal: { type: 'boost' | 'correct'; sceneIndex: number; timestamp?: number; intensity?: number; reason?: string },
  ) {
    await this.assertProjectOwnership(projectId, userId);
    return this.liveSteering.saveLiveSignal(projectId, signal);
  }

  async getLiveSignal(projectId: string, userId: string) {
    await this.assertProjectOwnership(projectId, userId);
    return this.liveSteering.getLiveSignal(projectId);
  }

  async clearLiveSignal(projectId: string, userId: string) {
    await this.assertProjectOwnership(projectId, userId);
    return this.liveSteering.clearLiveSignal(projectId);
  }
}
