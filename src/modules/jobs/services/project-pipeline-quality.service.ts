import { Injectable } from '@nestjs/common';
import { JobType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma';

@Injectable()
export class ProjectPipelineQualityService {
  constructor(private readonly prisma: PrismaService) {}

  async appendDegradedMeta(
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

  async appendStageMetrics(projectId: string, jobType: JobType, outputData: unknown): Promise<void> {
    const stageMetrics = this.extractStageMetrics(jobType, outputData);
    if (!stageMetrics) {
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

    const existingStageMetrics =
      existingMeta.stageMetrics &&
      typeof existingMeta.stageMetrics === 'object' &&
      !Array.isArray(existingMeta.stageMetrics)
        ? { ...(existingMeta.stageMetrics as Record<string, unknown>) }
        : {};

    const stageKey =
      jobType === JobType.GENERATE_IMAGES
        ? 'generateImages'
        : jobType === JobType.RENDER_VIDEO
          ? 'renderVideo'
          : jobType.toLowerCase();

    existingStageMetrics[stageKey] = stageMetrics;

    analysisResult._pipelineQuality = {
      ...existingMeta,
      stageMetrics: existingStageMetrics,
      updatedAt: new Date().toISOString(),
    };

    await this.prisma.project.update({
      where: { id: projectId },
      data: { analysisResult: analysisResult as Prisma.InputJsonValue },
    });
  }

  async clearMeta(projectId: string): Promise<void> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { analysisResult: true },
    });
    if (
      !project?.analysisResult ||
      typeof project.analysisResult !== 'object' ||
      Array.isArray(project.analysisResult)
    ) {
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

  private toFiniteNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return null;
  }

  private extractStageMetrics(jobType: JobType, outputData: unknown): Record<string, unknown> | null {
    if (!outputData || typeof outputData !== 'object' || Array.isArray(outputData)) {
      return null;
    }

    const payload = outputData as Record<string, unknown>;
    const updatedAt = new Date().toISOString();

    if (jobType === JobType.GENERATE_IMAGES) {
      const images = Array.isArray(payload.images)
        ? (payload.images as Array<Record<string, unknown>>)
        : [];
      const totalScenes = Math.max(
        0,
        Math.round(this.toFiniteNumber(payload.totalScenes) ?? images.length),
      );
      const generatedCount = Math.max(
        0,
        Math.round(this.toFiniteNumber(payload.generatedCount) ?? images.length),
      );
      const failedCount = Math.max(
        0,
        Math.round(this.toFiniteNumber(payload.failedCount) ?? 0),
      );

      const exposedCount = images.filter((item) => item?.exposed === true).length;
      const unexposedCount = images.filter((item) => item?.exposed === false).length;
      const fallbackCount = images.filter((item) => item?.isFallback === true).length;

      return {
        totalScenes,
        generatedCount,
        failedCount,
        exposedCount,
        unexposedCount,
        fallbackCount,
        exposureRate: totalScenes > 0 ? Number((exposedCount / totalScenes).toFixed(4)) : 0,
        updatedAt,
      };
    }

    if (jobType === JobType.RENDER_VIDEO) {
      const explicitMetrics =
        payload.renderMetrics &&
        typeof payload.renderMetrics === 'object' &&
        !Array.isArray(payload.renderMetrics)
          ? (payload.renderMetrics as Record<string, unknown>)
          : {};

      return {
        totalSceneCount: Math.max(
          0,
          Math.round(
            this.toFiniteNumber(explicitMetrics.totalSceneCount) ??
              this.toFiniteNumber(payload.framesUsed) ??
              0,
          ),
        ),
        postVerseSceneCount: Math.max(
          0,
          Math.round(this.toFiniteNumber(explicitMetrics.postVerseSceneCount) ?? 0),
        ),
        skippedQualityCount: Math.max(
          0,
          Math.round(this.toFiniteNumber(explicitMetrics.skippedQualityCount) ?? 0),
        ),
        skippedMissingCount: Math.max(
          0,
          Math.round(this.toFiniteNumber(explicitMetrics.skippedMissingCount) ?? 0),
        ),
        diversityFillCount: Math.max(
          0,
          Math.round(this.toFiniteNumber(explicitMetrics.diversityFillCount) ?? 0),
        ),
        continuityFillCount: Math.max(
          0,
          Math.round(this.toFiniteNumber(explicitMetrics.continuityFillCount) ?? 0),
        ),
        allowUnexposedFallback: explicitMetrics.allowUnexposedFallback === true,
        unexposedRatio: Math.max(
          0,
          Number((this.toFiniteNumber(explicitMetrics.unexposedRatio) ?? 0).toFixed(4)),
        ),
        framesUsed: Math.max(0, Math.round(this.toFiniteNumber(payload.framesUsed) ?? 0)),
        durationSec: Math.max(0, this.toFiniteNumber(payload.duration) ?? 0),
        updatedAt,
      };
    }

    return null;
  }
}

