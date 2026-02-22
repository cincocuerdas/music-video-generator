import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma';

@Injectable()
export class EmbeddingsService {
  private readonly logger = new Logger(EmbeddingsService.name);
  private readonly models = ['text-embedding-004', 'gemini-embedding-001'];
  private readonly expectedDimensions = 768;
  private readonly embeddingApiVersions = ['v1beta', 'v1'];

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async enrichFeedbackWithEmbedding(feedbackId: string, prompt: string): Promise<void> {
    try {
      const embedding = await this.generateEmbedding(prompt);
      if (!embedding) {
        return;
      }

      const vectorLiteral = this.toVectorLiteral(embedding);
      await this.prisma.$executeRaw`
        UPDATE "GenerationFeedback"
        SET "embedding" = ${vectorLiteral}::vector
        WHERE "id" = ${feedbackId}::uuid
      `;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.warn(`Failed to persist embedding for feedback ${feedbackId}: ${message}`);
    }
  }

  async generateEmbedding(prompt: string): Promise<number[] | null> {
    const safePrompt = (prompt || '').trim();
    if (!safePrompt) {
      return null;
    }

    const apiKey = this.configService.get<string>('GEMINI_API_KEY');
    if (!apiKey) {
      this.logger.warn('GEMINI_API_KEY is missing. Falling back to deterministic local embedding.');
      return this.generateDeterministicEmbedding(safePrompt);
    }

    let lastError: unknown = null;
    for (const model of this.models) {
      const payload = {
        model: `models/${model}`,
        content: {
          parts: [{ text: safePrompt }],
        },
      };

      for (const apiVersion of this.embeddingApiVersions) {
        const url = `https://generativelanguage.googleapis.com/${apiVersion}/models/${model}:embedContent`;
        try {
          const response = await axios.post(url, payload, {
            params: { key: apiKey },
            timeout: 15000,
          });

          const values = response.data?.embedding?.values;
          if (!Array.isArray(values)) {
            this.logger.warn(
              `Gemini embedding response did not include embedding.values array for model ${model}.`,
            );
            continue;
          }

          const normalized = values.map((value: unknown) =>
            typeof value === 'number' && Number.isFinite(value) ? value : 0,
          );

          if (normalized.length === this.expectedDimensions) {
            return normalized;
          }

          if (normalized.length > this.expectedDimensions) {
            this.logger.warn(
              `Gemini model ${model} returned ${normalized.length} dimensions, truncating to ${this.expectedDimensions}.`,
            );
            return normalized.slice(0, this.expectedDimensions);
          }

          this.logger.warn(
            `Gemini model ${model} returned ${normalized.length} dimensions, padding to ${this.expectedDimensions}.`,
          );
          return [...normalized, ...new Array(this.expectedDimensions - normalized.length).fill(0)];
        } catch (error) {
          lastError = error;
          if (axios.isAxiosError(error)) {
            const status = error.response?.status;
            const statusText = error.response?.statusText || 'unknown';
            this.logger.warn(
              `Embedding endpoint failed (${url}) with HTTP ${status ?? 'unknown'} ${statusText}.`,
            );
            continue;
          }
        }
      }
    }

    const message = lastError instanceof Error ? lastError.message : 'unknown error';
    this.logger.warn(
      `Embedding generation skipped due to provider error (${message}). Falling back to deterministic local embedding.`,
    );
    return this.generateDeterministicEmbedding(safePrompt);
  }

  private toVectorLiteral(embedding: number[]): string {
    return `[${embedding.join(',')}]`;
  }

  private generateDeterministicEmbedding(prompt: string): number[] {
    const values = new Array<number>(this.expectedDimensions);
    for (let i = 0; i < this.expectedDimensions; i += 1) {
      const hash = createHash('sha256').update(`${prompt}:${i}`).digest();
      const int = hash.readUInt32BE(0);
      values[i] = (int / 0xffffffff) * 2 - 1;
    }
    return values;
  }
}
