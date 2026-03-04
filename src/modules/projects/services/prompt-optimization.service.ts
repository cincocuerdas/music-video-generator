import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma';
import { EmbeddingsService } from '../../embeddings';
import { parsePositiveIntEnv } from '../../../common/utils/env-parsers';

@Injectable()
export class PromptOptimizationService {
  private readonly logger = new Logger(PromptOptimizationService.name);
  private readonly pgvectorAnnCandidateLimit = parsePositiveIntEnv(
    'PGVECTOR_ANN_CANDIDATE_LIMIT',
    250,
  );
  private readonly pgvectorSimilarityLimit = parsePositiveIntEnv(
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

  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddingsService: EmbeddingsService,
  ) {}

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

    if (totalVotes < 5) {
      this.logger.log(`🧠 Not enough feedback for style "${style}" (${totalVotes} votes). Using defaults.`);
      return { qualityBoost, negativeBoost, confidence: 0 };
    }

    const successRate = likesCount / totalVotes;
    confidence = Math.min(totalVotes / 50, 1);

    this.logger.log(`🧠 Applying AI learning for "${style}": ${totalVotes} votes, ${Math.round(successRate * 100)}% success`);

    if (successRate > 0.5 && successfulPrompts.length >= 3) {
      const successWords = successfulPrompts
        .flatMap(p => p.prompt.toLowerCase().split(/[\s,]+/))
        .filter(w => w.length > 5);

      const wordFreq = successWords.reduce((acc, word) => {
        acc[word] = (acc[word] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

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

    if (dislikesCount > totalVotes * 0.3) {
      negativeBoost = 'amateur, distorted, artifacts, oversaturated, underexposed';
      this.logger.log(`  ⚠️ High dislike rate (${Math.round((1 - successRate) * 100)}%) - adding safety negative prompts`);
    }

    if (failedPrompts.length >= 3) {
      const failWords = failedPrompts
        .flatMap(p => p.prompt.toLowerCase().split(/[\s,]+/))
        .filter(w => w.length > 4);

      const failWordFreq = failWords.reduce((acc, word) => {
        acc[word] = (acc[word] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

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
}
