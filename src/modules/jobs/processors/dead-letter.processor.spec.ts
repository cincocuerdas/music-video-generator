import { JobType } from '../dto';
import { DeadLetterProcessor } from './dead-letter.processor';

const createJob = (data: Record<string, unknown> | undefined, id = 'dlq-job-1') =>
  ({
    id,
    data,
  }) as any;

describe('DeadLetterProcessor', () => {
  it('returns normalized dead-letter summary for complete payload', async () => {
    const processor = new DeadLetterProcessor();
    const warnSpy = jest
      .spyOn((processor as any).logger, 'warn')
      .mockImplementation(() => undefined);

    const result = await processor.process(
      createJob({
        sourceQueue: 'analysis',
        projectId: 'project-123',
        jobId: 'job-456',
        jobType: JobType.ANALYZE_LYRICS,
        retryable: false,
        category: 'permanent',
        capturedAt: '2026-03-02T10:00:00.000Z',
      }),
    );

    expect(result).toEqual({
      deadLetterJobId: 'dlq-job-1',
      sourceQueue: 'analysis',
      projectId: 'project-123',
      originalJobId: 'job-456',
      jobType: JobType.ANALYZE_LYRICS,
      retryable: false,
      category: 'permanent',
      capturedAt: '2026-03-02T10:00:00.000Z',
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        '[dead-letter] queued entry source=analysis project=project-123 originalJob=job-456 type=ANALYZE_LYRICS retryable=false category=permanent',
      ),
    );
  });

  it('fills safe defaults when payload is missing', async () => {
    const processor = new DeadLetterProcessor();
    jest.spyOn((processor as any).logger, 'warn').mockImplementation(() => undefined);

    const result = await processor.process(createJob(undefined, 'dlq-job-2'));

    expect(result).toEqual({
      deadLetterJobId: 'dlq-job-2',
      sourceQueue: 'unknown',
      projectId: 'unknown',
      originalJobId: 'unknown',
      jobType: 'unknown',
      retryable: false,
      category: 'unknown',
      capturedAt: null,
    });
  });

  it('coerces retryable flag to boolean', async () => {
    const processor = new DeadLetterProcessor();
    jest.spyOn((processor as any).logger, 'warn').mockImplementation(() => undefined);

    const result = await processor.process(
      createJob({
        sourceQueue: 'video-render',
        projectId: 'project-999',
        jobId: 'job-999',
        jobType: JobType.RENDER_VIDEO,
        retryable: 1,
        category: 'transient',
      }),
    );

    expect(result.retryable).toBe(true);
    expect(result.sourceQueue).toBe('video-render');
    expect(result.jobType).toBe(JobType.RENDER_VIDEO);
  });
});

