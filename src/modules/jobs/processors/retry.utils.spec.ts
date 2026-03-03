import {
  assessScriptResult,
  classifyJobError,
  isQuotaDegradedResult,
  validateScriptResultContract,
} from './retry.utils';

describe('assessScriptResult', () => {
  it('marks explicit failed status as failed', () => {
    const assessment = assessScriptResult({
      status: 'failed',
      success: false,
      degraded: false,
      degradedReasons: [],
      errorCode: 'script.failed',
      error: 'no useful output',
    });

    expect(assessment.normalizedStatus).toBe('failed');
    expect(assessment.message).toBe('no useful output');
    expect(assessment.rawStatus).toBe('failed');
  });

  it('marks degraded status as degraded', () => {
    const assessment = assessScriptResult({
      status: 'degraded',
      success: true,
      degraded: true,
      degradedReasons: ['placeholder'],
      warning: 'placeholders used',
    });

    expect(assessment.normalizedStatus).toBe('degraded');
    expect(assessment.message).toBe('placeholders used');
  });

  it('marks explicit success status as success', () => {
    const assessment = assessScriptResult({
      status: 'success',
      success: true,
      degraded: false,
      degradedReasons: [],
      message: 'ok',
    });

    expect(assessment.normalizedStatus).toBe('success');
    expect(assessment.message).toBe('ok');
  });

  it('fails malformed RESULT_JSON contract', () => {
    const assessment = assessScriptResult({
      status: 'success',
      message: 'ok',
    });

    expect(assessment.normalizedStatus).toBe('failed');
    expect(assessment.contractValid).toBe(false);
    expect(assessment.message).toContain('Invalid RESULT_JSON contract');
  });
});

describe('validateScriptResultContract', () => {
  it('validates expected fields', () => {
    const validation = validateScriptResultContract({
      status: 'success',
      success: true,
      degraded: false,
      degradedReasons: [],
    });

    expect(validation.valid).toBe(true);
  });

  it('reports contract issues for non-object payload', () => {
    const validation = validateScriptResultContract(null);
    expect(validation.valid).toBe(false);
    expect(validation.issues).toContain('result must be a JSON object');
  });

  it('requires errorCode for failed payloads', () => {
    const validation = validateScriptResultContract({
      status: 'failed',
      success: false,
      degraded: false,
      degradedReasons: [],
      error: 'missing code',
    });

    expect(validation.valid).toBe(false);
    expect(validation.issues).toContain(
      'errorCode must be a non-empty string when status=failed or success=false',
    );
  });
});

describe('classifyJobError', () => {
  it('marks missing youtube url as permanent', () => {
    const classification = classifyJobError(
      new Error('No YouTube URL found for project'),
    );

    expect(classification.category).toBe('permanent');
    expect(classification.retryable).toBe(false);
  });

  it('marks timeout as transient', () => {
    const classification = classifyJobError(
      new Error('Script timed out after 300s'),
    );

    expect(classification.category).toBe('transient');
    expect(classification.retryable).toBe(true);
  });
});

describe('isQuotaDegradedResult', () => {
  it('detects quota/rate-limit degraded reasons', () => {
    const hasQuota = isQuotaDegradedResult({
      status: 'degraded',
      success: true,
      degraded: true,
      degradedReasons: [
        "gemini-failed: HTTP 429 calling model 'models/gemini-2.5-flash': quota exceeded",
      ],
    });

    expect(hasQuota).toBe(true);
  });

  it('returns false for non-quota degraded payloads', () => {
    const hasQuota = isQuotaDegradedResult({
      status: 'degraded',
      success: true,
      degraded: true,
      degradedReasons: ['youtube_subtitles_unavailable'],
      warning: 'fallback subtitles unavailable',
    });

    expect(hasQuota).toBe(false);
  });
});

