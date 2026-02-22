import { JobStatus, JobType, ProjectStatus } from '@prisma/client';
import {
  deriveProjectPipelineStatus,
  extractDegradedReasonCodesFromOutputData,
  extractDegradedReasonsFromOutputData,
  summarizePipelineQuality,
} from './pipeline-quality.utils';

describe('pipeline-quality.utils', () => {
  it('extracts degraded reasons from outputData payload', () => {
    const reasons = extractDegradedReasonsFromOutputData(
      {
        status: 'degraded',
        degradedReasons: ['image_generation_empty', 'db_save_warning'],
      },
      JobType.GENERATE_IMAGES,
    );

    expect(reasons).toEqual([
      'GENERATE_IMAGES: image_generation_empty',
      'GENERATE_IMAGES: db_save_warning',
    ]);
  });

  it('extracts normalized degraded reason codes from outputData payload', () => {
    const reasonCodes = extractDegradedReasonCodesFromOutputData(
      {
        status: 'degraded',
        degradedReasons: ['image_generation_empty', 'db save warning'],
      },
      JobType.GENERATE_IMAGES,
    );

    expect(reasonCodes).toEqual([
      'generate_images.image_generation_empty',
      'generate_images.db_save_warning',
    ]);
  });

  it('summarizes degraded pipeline output from completed jobs', () => {
    const summary = summarizePipelineQuality([
      {
        type: JobType.YOUTUBE_DOWNLOAD,
        status: JobStatus.COMPLETED,
        outputData: { status: 'success' },
      },
      {
        type: JobType.RENDER_VIDEO,
        status: JobStatus.COMPLETED,
        outputData: { status: 'degraded', message: 'placeholder frames used' },
      },
    ]);

    expect(summary.degraded).toBe(true);
    expect(summary.hasFailedJob).toBe(false);
    expect(summary.degradedReasons).toContain(
      'RENDER_VIDEO: placeholder frames used',
    );
    expect(summary.degradedReasonCodes).toContain('render_video.placeholder_frames_used');
  });

  it('flags hasFailedJob when a core pipeline job failed', () => {
    const summary = summarizePipelineQuality([
      {
        type: JobType.TRANSCRIPTION,
        status: JobStatus.FAILED,
      },
      {
        type: JobType.TRAIN_LORA,
        status: JobStatus.COMPLETED,
        outputData: { status: 'degraded', message: 'insufficient_data' },
      },
    ]);

    expect(summary.hasFailedJob).toBe(true);
    // TRAIN_LORA is intentionally not part of core pipeline degradation summary.
    expect(summary.degraded).toBe(false);
    expect(summary.degradedReasons).toEqual([]);
    expect(summary.degradedReasonCodes).toEqual([]);
  });

  it('derives degraded pipelineStatus for completed projects with degraded outputs', () => {
    const pipelineStatus = deriveProjectPipelineStatus(
      ProjectStatus.COMPLETED,
      {
        degraded: true,
        degradedReasons: ['RENDER_VIDEO: fallback output'],
        degradedReasonCodes: ['render_video.fallback_output'],
        hasFailedJob: false,
      },
    );

    expect(pipelineStatus).toBe('degraded');
  });

  it('derives success pipelineStatus for clean completed projects', () => {
    const pipelineStatus = deriveProjectPipelineStatus(
      ProjectStatus.COMPLETED,
      {
        degraded: false,
        degradedReasons: [],
        degradedReasonCodes: [],
        hasFailedJob: false,
      },
    );

    expect(pipelineStatus).toBe('success');
  });
});
