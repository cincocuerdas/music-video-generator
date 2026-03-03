import { JobStatus, JobType } from '@prisma/client';
import { PipelineTransitionService } from './pipeline-transition.service';

const makeJob = (params: { type: JobType; status: JobStatus; id?: string; projectId?: string }) =>
  ({
    id: params.id ?? `job-${params.type}`,
    projectId: params.projectId ?? 'project-1',
    type: params.type,
    status: params.status,
    progress: 0,
    currentStep: null,
    workerId: null,
    errorMessage: null,
    inputData: {},
    outputData: null,
    createdAt: new Date('2026-03-02T00:00:00.000Z'),
    updatedAt: new Date('2026-03-02T00:00:00.000Z'),
  }) as any;

describe('PipelineTransitionService', () => {
  const service = new PipelineTransitionService();

  it('returns dispatch when there is a pending pipeline job', () => {
    const decision = service.resolveAdvanceDecision('project-1', [
      makeJob({ type: JobType.YOUTUBE_DOWNLOAD, status: JobStatus.COMPLETED }),
      makeJob({ type: JobType.TRANSCRIPTION, status: JobStatus.PENDING }),
    ]);

    expect(decision.kind).toBe('dispatch');
    if (decision.kind === 'dispatch') {
      expect(decision.job.type).toBe(JobType.TRANSCRIPTION);
    }
  });

  it('returns wait when a pipeline job is processing', () => {
    const decision = service.resolveAdvanceDecision('project-1', [
      makeJob({ type: JobType.GENERATE_IMAGES, status: JobStatus.PROCESSING }),
    ]);
    expect(decision.kind).toBe('wait');
  });

  it('returns complete when all pipeline jobs are completed', () => {
    const decision = service.resolveAdvanceDecision('project-1', [
      makeJob({ type: JobType.YOUTUBE_DOWNLOAD, status: JobStatus.COMPLETED }),
      makeJob({ type: JobType.TRANSCRIPTION, status: JobStatus.COMPLETED }),
      makeJob({ type: JobType.ANALYZE_LYRICS, status: JobStatus.COMPLETED }),
      makeJob({ type: JobType.GENERATE_IMAGES, status: JobStatus.COMPLETED }),
      makeJob({ type: JobType.RENDER_VIDEO, status: JobStatus.COMPLETED }),
      makeJob({ type: JobType.FINALIZE, status: JobStatus.COMPLETED }),
    ]);
    expect(decision.kind).toBe('complete');
  });
});

