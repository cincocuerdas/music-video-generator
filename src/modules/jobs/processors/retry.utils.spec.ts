import { assessScriptResult } from './retry.utils';

describe('assessScriptResult', () => {
  it('marks explicit failed status as failed', () => {
    const assessment = assessScriptResult({
      status: 'failed',
      error: 'no useful output',
    });

    expect(assessment.normalizedStatus).toBe('failed');
    expect(assessment.message).toBe('no useful output');
    expect(assessment.rawStatus).toBe('failed');
  });

  it('marks success=false as failed even without status', () => {
    const assessment = assessScriptResult({
      success: false,
      message: 'step failed',
    });

    expect(assessment.normalizedStatus).toBe('failed');
    expect(assessment.message).toBe('step failed');
    expect(assessment.rawStatus).toBeNull();
  });

  it('marks degraded status as degraded', () => {
    const assessment = assessScriptResult({
      status: 'degraded',
      warning: 'placeholders used',
    });

    expect(assessment.normalizedStatus).toBe('degraded');
    expect(assessment.message).toBe('placeholders used');
  });

  it('marks explicit success status as success', () => {
    const assessment = assessScriptResult({
      status: 'success',
      message: 'ok',
    });

    expect(assessment.normalizedStatus).toBe('success');
    expect(assessment.message).toBe('ok');
  });

  it('marks success=true as success when status is missing', () => {
    const assessment = assessScriptResult({
      success: true,
    });

    expect(assessment.normalizedStatus).toBe('success');
    expect(assessment.rawStatus).toBeNull();
  });

  it('marks non-standard status as unknown', () => {
    const assessment = assessScriptResult({
      status: 'insufficient_data',
      message: 'not enough likes',
    });

    expect(assessment.normalizedStatus).toBe('unknown');
    expect(assessment.rawStatus).toBe('insufficient_data');
    expect(assessment.message).toBe('not enough likes');
  });

  it('returns unknown for non-object input', () => {
    const assessment = assessScriptResult(null);

    expect(assessment.normalizedStatus).toBe('unknown');
    expect(assessment.rawStatus).toBeNull();
    expect(assessment.message).toBeNull();
  });
});
