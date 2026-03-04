import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma';
import { EmbeddingsService } from '../../embeddings';
import { JobsService } from '../../jobs/jobs.service';
import { parsePositiveIntEnv } from '../../../common/utils/env-parsers';
import { CreateFeedbackDto } from '../dto';

@Injectable()
export class ProjectFeedbackService {
  private readonly logger = new Logger(ProjectFeedbackService.name);
  private readonly feedbackDedupeWindowMs = parsePositiveIntEnv(
    'FEEDBACK_DEDUPE_WINDOW_MS',
    5_000,
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddingsService: EmbeddingsService,
    private readonly jobsService: JobsService,
  ) {}

  async addFeedback(projectId: string, dto: CreateFeedbackDto) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
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

  async getFeedback(projectId: string) {
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

    const allWords = recentSuccessfulPrompts
      .flatMap((prompt) => prompt.toLowerCase().split(/\s+/))
      .filter(w => w.length > 4);

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
}
