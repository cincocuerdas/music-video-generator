import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { PrismaService } from '../prisma';
import { JobsService } from '../jobs/jobs.service';
import { EventsGateway } from '../events/events.gateway';
import { EmbeddingsService } from '../embeddings';
import { RedisClientService } from '../redis';
import { isValidYoutubeUrl } from '../../common/constants';
import {
  CreateProjectDto,
  UpdateProjectDto,
  StartGenerationDto,
  CreateFeedbackDto,
} from './dto';
import Redis from 'ioredis';
import {
  deriveProjectPipelineStatus,
  summarizePipelineQuality,
} from '../jobs/pipeline-quality.utils';

@Injectable()
export class ProjectsService implements OnModuleDestroy {
  private readonly logger = new Logger(ProjectsService.name);
  private redisClient: Redis | null = null;
  private readonly feedbackDedupeWindowMs = this.parsePositiveIntEnv(
    'FEEDBACK_DEDUPE_WINDOW_MS',
    5_000,
  );
  private readonly pgvectorAnnCandidateLimit = this.parsePositiveIntEnv(
    'PGVECTOR_ANN_CANDIDATE_LIMIT',
    250,
  );
  private readonly pgvectorSimilarityLimit = this.parsePositiveIntEnv(
    'PGVECTOR_SIMILARITY_LIMIT',
    10,
  );
  private readonly stopWords = new Set([
    'with', 'from', 'that', 'this', 'your', 'have', 'has', 'were', 'their',
    'there', 'into', 'over', 'under', 'about', 'after', 'before', 'very',
    'just', 'like', 'more', 'less', 'then', 'than', 'while', 'when', 'where',
    'which', 'also', 'only', 'some', 'such', 'each', 'other', 'through',
    'using', 'used', 'make', 'made', 'looks', 'look', 'image', 'scene',
    'prompt', 'video', 'shot', 'render',
  ]);
  private readonly styleModifiers = [
    'cinematic', 'photorealistic', 'hyperrealistic', 'ultra detailed', 'high detail',
    'masterpiece', 'professional', 'dramatic', 'atmospheric', 'film grain',
    'anamorphic', 'wide angle', 'close-up', 'depth of field', 'bokeh', '8k', 'uhd',
  ];
  private readonly lightingTechniques = [
    'volumetric lighting', 'rim lighting', 'backlight', 'backlighting', 'golden hour',
    'soft lighting', 'hard lighting', 'neon lighting', 'studio lighting', 'ambient light',
    'dramatic lighting', 'high key', 'low key', 'global illumination', 'sunset lighting',
    'moonlight', 'daylight', 'warm light', 'cool light',
  ];

  private parsePositiveIntEnv(key: string, fallback: number): number {
    const raw = process.env[key];
    if (!raw) {
      return fallback;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobsService: JobsService,
    private readonly eventsGateway: EventsGateway,
    private readonly embeddingsService: EmbeddingsService,
    private readonly redisClientService: RedisClientService,
  ) {
    this.initRedis();
  }

  private async initRedis() {
    try {
      this.redisClient = this.redisClientService.createClient('projects-steering');
      this.logger.log('Redis client initialized for live steering');
    } catch (error) {
      this.logger.warn(`Redis not available for steering: ${error.message}`);
    }
  }

  async onModuleDestroy() {
    if (this.redisClient) {
      await this.redisClientService.releaseClient(this.redisClient, 'projects-steering');
      this.redisClient = null;
    }
  }

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
      data: updateProjectDto,
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
  // AI FEEDBACK (Learning System)
  // ═══════════════════════════════════════════════════════════════════════════

  async addFeedback(projectId: string, userId: string, dto: CreateFeedbackDto) {
    await this.assertProjectOwnership(projectId, userId);

    // Get project to auto-fill style if not provided
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, userId },
      select: { visualStyle: true },
    });

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    const normalizedPrompt = (dto.prompt || '').trim();
    const resolvedStyle = dto.style || project.visualStyle || 'unknown';
    const duplicateFeedback = await this.findDuplicateFeedback({
      projectId,
      score: dto.score,
      prompt: normalizedPrompt,
      frameTime: dto.frameTime,
      style: resolvedStyle,
    });

    if (duplicateFeedback) {
      this.logger.warn(
        `Ignoring duplicate feedback for project ${projectId} (existingId=${duplicateFeedback.id})`,
      );
      return {
        id: duplicateFeedback.id,
        message: 'Duplicate feedback ignored.',
      };
    }

    // Create feedback record
    const feedback = await this.prisma.generationFeedback.create({
      data: {
        projectId,
        score: dto.score,
        prompt: normalizedPrompt,
        frameTime: dto.frameTime,
        style: resolvedStyle,
      },
    });

    await this.embeddingsService.enrichFeedbackWithEmbedding(feedback.id, normalizedPrompt);

    if (dto.score > 0) {
      const style = feedback.style || project.visualStyle || 'unknown';
      const likesCount = await this.prisma.generationFeedback.count({
        where: {
          style,
          score: { gt: 0 },
        },
      });

      try {
        await this.jobsService.triggerStyleLoraTraining(projectId, style, likesCount);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        this.logger.warn(
          `Failed to enqueue TRAIN_LORA for style "${style}" (likes=${likesCount}): ${message}`,
        );
      }
    }

    this.logger.log(
      `Feedback recorded: ${dto.score > 0 ? '👍' : '👎'} for project ${projectId} (style: ${feedback.style})`,
    );

    return {
      id: feedback.id,
      message: dto.score > 0 ? 'Thanks! AI will learn from this.' : 'Noted. AI will avoid this pattern.',
    };
  }

  private async findDuplicateFeedback(params: {
    projectId: string;
    score: number;
    prompt: string;
    frameTime?: number;
    style?: string;
  }): Promise<{ id: string } | null> {
    type DuplicateFeedbackRow = { id: string };

    const cutoff = new Date(Date.now() - this.feedbackDedupeWindowMs);
    const targetStyle = (params.style || '').trim() || null;
    const targetFrameTime =
      typeof params.frameTime === 'number' ? params.frameTime : null;

    const rows = await this.prisma.$queryRaw<DuplicateFeedbackRow[]>`
      SELECT "id"
      FROM "GenerationFeedback"
      WHERE "projectId" = ${params.projectId}::uuid
        AND "score" = ${params.score}
        AND "createdAt" >= ${cutoff}
        AND LOWER(TRIM(COALESCE("prompt", ''))) = LOWER(TRIM(${params.prompt}))
        AND (
          ${targetStyle}::text IS NULL
          OR LOWER(TRIM(COALESCE("style", ''))) = LOWER(TRIM(${targetStyle}::text))
        )
        AND (
          ${targetFrameTime}::double precision IS NULL
          OR (
            "frameTime" IS NOT NULL
            AND ABS("frameTime" - ${targetFrameTime}::double precision) <= 1
          )
        )
      ORDER BY "createdAt" DESC
      LIMIT 1
    `;

    return rows[0] || null;
  }

  async getFeedback(projectId: string, userId: string) {
    await this.assertProjectOwnership(projectId, userId);

    const feedbacks = await this.prisma.generationFeedback.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });

    return {
      projectId,
      total: feedbacks.length,
      likes: feedbacks.filter(f => f.score > 0).length,
      dislikes: feedbacks.filter(f => f.score < 0).length,
      feedbacks,
    };
  }

  async getFeedbackStats(style?: string) {
    type FeedbackStatsRow = {
      likes: number | bigint | null;
      dislikes: number | bigint | null;
      recentSuccessfulPrompts: string[] | null;
    };

    const normalizedStyle = style?.trim() || null;
    const rows = await this.prisma.$queryRaw<FeedbackStatsRow[]>`
      WITH filtered AS (
        SELECT "prompt", "score", "createdAt"
        FROM "GenerationFeedback"
        WHERE (${normalizedStyle}::text IS NULL OR "style" = ${normalizedStyle}::text)
      ),
      stats AS (
        SELECT
          COUNT(*) FILTER (WHERE "score" = 1) AS likes,
          COUNT(*) FILTER (WHERE "score" = -1) AS dislikes
        FROM filtered
      ),
      recent_successful AS (
        SELECT "prompt"
        FROM filtered
        WHERE "score" = 1
        ORDER BY "createdAt" DESC
        LIMIT 50
      )
      SELECT
        stats.likes,
        stats.dislikes,
        COALESCE(
          array_remove(array_agg(recent_successful."prompt"), NULL),
          ARRAY[]::text[]
        ) AS "recentSuccessfulPrompts"
      FROM stats
      LEFT JOIN recent_successful ON TRUE
      GROUP BY stats.likes, stats.dislikes
    `;

    const stats = rows[0];
    const likes = Number(stats?.likes || 0);
    const dislikes = Number(stats?.dislikes || 0);
    const recentSuccessfulPrompts = stats?.recentSuccessfulPrompts || [];

    // Extract common keywords from successful prompts
    const allWords = recentSuccessfulPrompts
      .flatMap((prompt) => prompt.toLowerCase().split(/\s+/))
      .filter(w => w.length > 4); // Skip short words

    const wordFreq = allWords.reduce((acc, word) => {
      acc[word] = (acc[word] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const topKeywords = Object.entries(wordFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([word]) => word);

    return {
      style: style || 'all',
      totalLikes: likes,
      totalDislikes: dislikes,
      successRate: likes + dislikes > 0 ? Math.round((likes / (likes + dislikes)) * 100) : 0,
      topSuccessfulKeywords: topKeywords,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // AI PROMPT OPTIMIZATION (Level 2 Learning)
  // ═══════════════════════════════════════════════════════════════════════════

  async optimizePromptFromFeedback(style: string): Promise<{
    qualityBoost: string;
    negativeBoost: string;
    confidence: number;
  }> {
    type OptimizationRow = {
      likes: number | bigint | null;
      dislikes: number | bigint | null;
      prompt: string | null;
      score: number | null;
    };

    // Default values (no learning applied)
    let qualityBoost = '';
    let negativeBoost = '';
    let confidence = 0;

    const rows = await this.prisma.$queryRaw<OptimizationRow[]>`
      WITH filtered AS (
        SELECT "prompt", "score", "createdAt"
        FROM "GenerationFeedback"
        WHERE "style" = ${style}
          AND "score" IN (1, -1)
      ),
      stats AS (
        SELECT
          COUNT(*) FILTER (WHERE "score" = 1) AS likes,
          COUNT(*) FILTER (WHERE "score" = -1) AS dislikes
        FROM filtered
      ),
      recent AS (
        SELECT "prompt", "score"
        FROM filtered
        ORDER BY "createdAt" DESC
        LIMIT 40
      )
      SELECT
        stats.likes,
        stats.dislikes,
        recent."prompt",
        recent."score"
      FROM stats
      LEFT JOIN recent ON TRUE
    `;

    const likesCount = Number(rows[0]?.likes || 0);
    const dislikesCount = Number(rows[0]?.dislikes || 0);
    const recentPrompts = rows
      .filter((row) => !!row.prompt && (row.score === 1 || row.score === -1))
      .map((row) => ({
        prompt: row.prompt as string,
        score: row.score as number,
      }));

    const successfulPrompts = recentPrompts
      .filter((entry) => entry.score === 1)
      .slice(0, 20)
      .map((entry) => ({ prompt: entry.prompt }));
    const failedPrompts = recentPrompts
      .filter((entry) => entry.score === -1)
      .slice(0, 20)
      .map((entry) => ({ prompt: entry.prompt }));

    const totalVotes = likesCount + dislikesCount;

    // Only apply learning if we have enough data (minimum 5 votes)
    if (totalVotes < 5) {
      this.logger.log(`🧠 Not enough feedback for style "${style}" (${totalVotes} votes). Using defaults.`);
      return { qualityBoost, negativeBoost, confidence: 0 };
    }

    const successRate = likesCount / totalVotes;
    confidence = Math.min(totalVotes / 50, 1); // Max confidence at 50 votes

    this.logger.log(`🧠 Applying AI learning for "${style}": ${totalVotes} votes, ${Math.round(successRate * 100)}% success`);

    // A. POSITIVE LEARNING - Extract winning patterns from liked prompts
    if (successRate > 0.5 && successfulPrompts.length >= 3) {
      // Extract frequent quality keywords from successful prompts
      const successWords = successfulPrompts
        .flatMap(p => p.prompt.toLowerCase().split(/[\s,]+/))
        .filter(w => w.length > 5);

      const wordFreq = successWords.reduce((acc, word) => {
        acc[word] = (acc[word] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      // Quality keywords that appear frequently in successful prompts
      const qualityKeywords = ['masterpiece', 'cinematic', 'detailed', 'professional', 'stunning',
                               'volumetric', 'lighting', 'atmospheric', 'dramatic', '8k', 'uhd'];

      const foundQuality = qualityKeywords.filter(kw =>
        Object.keys(wordFreq).some(w => w.includes(kw))
      );

      if (foundQuality.length > 0) {
        qualityBoost = foundQuality.slice(0, 3).join(', ');
        this.logger.log(`  ✨ Quality boost: ${qualityBoost}`);
      }
    }

    // B. NEGATIVE LEARNING - Avoid patterns from disliked prompts
    if (dislikesCount > totalVotes * 0.3) {
      // High dislike rate - add safety terms
      negativeBoost = 'amateur, distorted, artifacts, oversaturated, underexposed';
      this.logger.log(`  ⚠️ High dislike rate (${Math.round((1 - successRate) * 100)}%) - adding safety negative prompts`);
    }

    // C. SPECIFIC PATTERN AVOIDANCE
    // If we have failed prompts, try to find common problematic patterns
    if (failedPrompts.length >= 3) {
      const failWords = failedPrompts
        .flatMap(p => p.prompt.toLowerCase().split(/[\s,]+/))
        .filter(w => w.length > 4);

      const failWordFreq = failWords.reduce((acc, word) => {
        acc[word] = (acc[word] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      // Find words that appear often in failed prompts but not in successful ones
      const successWordSet = new Set(
        successfulPrompts.flatMap(p => p.prompt.toLowerCase().split(/[\s,]+/))
      );

      const problematicWords = Object.entries(failWordFreq)
        .filter(([word, count]) => count >= 2 && !successWordSet.has(word))
        .map(([word]) => word)
        .slice(0, 3);

      if (problematicWords.length > 0) {
        negativeBoost += (negativeBoost ? ', ' : '') + problematicWords.join(', ');
        this.logger.log(`  🚫 Avoiding problematic patterns: ${problematicWords.join(', ')}`);
      }
    }

    return { qualityBoost, negativeBoost, confidence };
  }

  private toVectorLiteral(values: number[]): string {
    return `[${values.join(',')}]`;
  }

  private extractFrequentTokens(prompts: string[], maxItems = 8): string[] {
    const freq = prompts
      .flatMap(prompt =>
        prompt
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter(token => token.length >= 4 && !this.stopWords.has(token)),
      )
      .reduce((acc, token) => {
        acc[token] = (acc[token] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

    return Object.entries(freq)
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxItems)
      .map(([token]) => token);
  }

  private extractFrequentPhrases(
    prompts: string[],
    dictionary: string[],
    maxItems = 4,
  ): string[] {
    const normalizedPrompts = prompts.map(prompt => prompt.toLowerCase());
    const counts = dictionary
      .map(phrase => ({
        phrase,
        count: normalizedPrompts.filter(prompt => prompt.includes(phrase)).length,
      }))
      .filter(item => item.count >= 1)
      .sort((a, b) => b.count - a.count)
      .slice(0, maxItems);

    return counts.map(item => item.phrase);
  }

  private buildPatternBoosts(likedPrompts: string[], dislikedPrompts: string[]) {
    const likedKeywords = this.extractFrequentTokens(likedPrompts, 6);
    const likedStyles = this.extractFrequentPhrases(likedPrompts, this.styleModifiers, 4);
    const likedLighting = this.extractFrequentPhrases(likedPrompts, this.lightingTechniques, 3);

    const dislikedKeywords = this.extractFrequentTokens(dislikedPrompts, 6);
    const dislikedStyles = this.extractFrequentPhrases(dislikedPrompts, this.styleModifiers, 4);
    const dislikedLighting = this.extractFrequentPhrases(dislikedPrompts, this.lightingTechniques, 3);

    const qualityParts = [...likedStyles, ...likedLighting, ...likedKeywords];
    const negativeParts = [...dislikedStyles, ...dislikedLighting, ...dislikedKeywords];

    return {
      qualityBoost: [...new Set(qualityParts)].slice(0, 10).join(', '),
      negativeBoost: [...new Set(negativeParts)].slice(0, 10).join(', '),
    };
  }

  // Get optimized prompt data for a project (called before image generation)
  async getPromptOptimization(projectId: string, userId?: string, currentPrompt?: string) {
    const project = userId
      ? await this.prisma.project.findFirst({
          where: { id: projectId, userId },
          select: { visualStyle: true },
        })
      : await this.prisma.project.findUnique({
          where: { id: projectId },
          select: { visualStyle: true },
        });

    if (!project?.visualStyle) {
      return { qualityBoost: '', negativeBoost: '', confidence: 0 };
    }

    try {
      const promptForSimilarity = currentPrompt?.trim() || project.visualStyle;
      const promptEmbedding = await this.embeddingsService.generateEmbedding(promptForSimilarity);

      if (!promptEmbedding) {
        return this.optimizePromptFromFeedback(project.visualStyle);
      }

      type SimilarFeedbackRow = {
        id: string;
        prompt: string;
        score: number;
        distance: number;
      };

      const vectorLiteral = this.toVectorLiteral(promptEmbedding);
      const similarityLimit = Math.max(1, this.pgvectorSimilarityLimit);
      const annCandidateLimit = Math.max(similarityLimit, this.pgvectorAnnCandidateLimit);
      let similarRows = await this.prisma.$queryRawUnsafe<SimilarFeedbackRow[]>(
        `
          WITH nearest AS (
            SELECT
              "id",
              "prompt",
              "score",
              "style",
              ("embedding" <=> $1::vector) AS "distance"
            FROM "GenerationFeedback"
            WHERE "embedding" IS NOT NULL
              AND "score" IN (1, -1)
            ORDER BY "embedding" <=> $1::vector
            LIMIT ${annCandidateLimit}
          )
          SELECT
            "id",
            "prompt",
            "score",
            "distance"
          FROM nearest
          WHERE "style" = $2::text
          ORDER BY "distance"
          LIMIT ${similarityLimit}
        `,
        vectorLiteral,
        project.visualStyle,
      );
      const minEmbeddedMatches = Math.min(5, similarityLimit);
      if (similarRows.length < minEmbeddedMatches) {
        // Fallback to exact style-filtered KNN when ANN candidate filtering is too sparse.
        const exactRows = await this.prisma.$queryRawUnsafe<SimilarFeedbackRow[]>(
          `
            SELECT
              "id",
              "prompt",
              "score",
              ("embedding" <=> $1::vector) AS "distance"
            FROM "GenerationFeedback"
            WHERE "embedding" IS NOT NULL
              AND "style" = $2::text
              AND "score" IN (1, -1)
            ORDER BY "embedding" <=> $1::vector
            LIMIT ${similarityLimit}
          `,
          vectorLiteral,
          project.visualStyle,
        );

        if (exactRows.length > similarRows.length) {
          similarRows = exactRows;
        }
      }

      const liked = (similarRows || []).filter(row => row.score > 0);
      const disliked = (similarRows || []).filter(row => row.score < 0);
      const enoughEmbeddedContext = (similarRows?.length || 0) >= 5 && liked.length + disliked.length >= 5;

      if (enoughEmbeddedContext) {
        const boosts = this.buildPatternBoosts(
          liked.map(row => row.prompt),
          disliked.map(row => row.prompt),
        );

        // Lower cosine distance is better; convert to confidence in [0,1]
        const avgDistance =
          similarRows.reduce((sum, row) => sum + Number(row.distance || 0), 0) / similarRows.length;
        const confidence = Math.max(0, Math.min(1, 1 - avgDistance));

        if (boosts.qualityBoost || boosts.negativeBoost) {
          this.logger.log(
            `Embedding optimization applied (style=${project.visualStyle}, similar=${similarRows.length}, liked=${liked.length}, disliked=${disliked.length}, confidence=${Math.round(confidence * 100)}%)`,
          );

          return {
            qualityBoost: boosts.qualityBoost,
            negativeBoost: boosts.negativeBoost,
            confidence,
          };
        }

        this.logger.log(
          `Embedding optimization produced weak patterns for style "${project.visualStyle}". Falling back to aggregate feedback heuristics.`,
        );
      } else {
        this.logger.log(
          `Not enough similar embedded feedback for style "${project.visualStyle}" (${similarRows?.length || 0}). Using fallback.`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(
        `Embedding optimization failed for style "${project.visualStyle}", using fallback heuristics: ${message}`,
      );
    }

    return this.optimizePromptFromFeedback(project.visualStyle);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LIVE STEERING (Real-time direction during generation)
  // ═══════════════════════════════════════════════════════════════════════════

  private getLiveSignalPath(projectId: string): string {
    const fs = require('fs');
    const path = require('path');
    const signalsDir = path.join(process.cwd(), 'output', 'live-signals');

    // Ensure directory exists
    if (!fs.existsSync(signalsDir)) {
      fs.mkdirSync(signalsDir, { recursive: true });
    }

    return path.join(signalsDir, `${projectId}.json`);
  }

  async saveLiveSignal(
    projectId: string,
    userId: string,
    signal: { type: 'boost' | 'correct'; sceneIndex: number; timestamp?: number; intensity?: number; reason?: string },
  ) {
    await this.assertProjectOwnership(projectId, userId);

    const fs = require('fs');
    const filePath = this.getLiveSignalPath(projectId);

    const signalData = {
      ...signal,
      timestamp: signal.timestamp || Date.now(),
      intensity: signal.intensity || 1.0,
      processed: false, // Python will set this to true after reading
    };

    // 1. Write to file (fallback for Python)
    fs.writeFileSync(filePath, JSON.stringify(signalData, null, 2));

    // 2. Write to Redis (faster for Python to read)
    if (this.redisClient) {
      try {
        const redisKey = `steering:${projectId}`;
        await this.redisClient.set(redisKey, JSON.stringify(signalData));
        // Set expiration (5 minutes) to auto-cleanup old signals
        await this.redisClient.expire(redisKey, 300);
        this.logger.debug(`Signal saved to Redis: ${redisKey}`);
      } catch (error) {
        this.logger.warn(`Failed to save signal to Redis: ${error.message}`);
      }
    }

    // 3. Emit immediate WebSocket acknowledgment
    this.eventsGateway.emitSteeringReceived(projectId, {
      signalType: signal.type,
      sceneIndex: signal.sceneIndex,
      status: 'queued',
    });

    this.logger.log(
      `🎬 Live signal saved: ${signal.type} at scene ${signal.sceneIndex} for project ${projectId}`,
    );

    return {
      success: true,
      message: signal.type === 'boost'
        ? '✅ Style locked in for next scenes'
        : '🔄 Adjusting direction for upcoming scenes',
      signal: signalData,
    };
  }

  async getLiveSignal(projectId: string, userId: string) {
    await this.assertProjectOwnership(projectId, userId);

    const fs = require('fs');
    const filePath = this.getLiveSignalPath(projectId);

    try {
      if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        return data;
      }
    } catch (error) {
      this.logger.warn(`Failed to read live signal for ${projectId}: ${error.message}`);
    }

    return null;
  }

  async clearLiveSignal(projectId: string, userId: string) {
    await this.assertProjectOwnership(projectId, userId);

    const fs = require('fs');
    const filePath = this.getLiveSignalPath(projectId);

    // 1. Clear file
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (error) {
      this.logger.warn(`Failed to clear live signal file for ${projectId}: ${error.message}`);
    }

    // 2. Clear Redis
    if (this.redisClient) {
      try {
        const redisKey = `steering:${projectId}`;
        await this.redisClient.del(redisKey);
      } catch (error) {
        this.logger.warn(`Failed to clear live signal from Redis for ${projectId}: ${error.message}`);
      }
    }

    this.logger.log(`🎬 Live signal cleared for project ${projectId}`);

    return {
      success: true,
      message: 'Signal cleared',
    };
  }
}
