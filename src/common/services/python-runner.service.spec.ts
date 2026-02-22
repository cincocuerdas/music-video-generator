import { extractProgressPayload, extractResultPayload } from './python-runner.service';

describe('extractProgressPayload', () => {
  it('returns null for non-progress lines', () => {
    expect(extractProgressPayload('hello world')).toBeNull();
    expect(extractProgressPayload('')).toBeNull();
  });

  it('extracts payload for plain progress line', () => {
    expect(extractProgressPayload('PROGRESS: Transcribed 30 segments...')).toBe(
      'Transcribed 30 segments...',
    );
  });

  it('extracts payload when line has prefix text', () => {
    expect(
      extractProgressPayload('[yt-dlp] WARN PROGRESS: Transcribed 35 segments...'),
    ).toBe('Transcribed 35 segments...');
  });

  it('extracts payload when line has ANSI color codes', () => {
    expect(
      extractProgressPayload('\u001b[33mPROGRESS: {"type":"progress","data":{"progress":42}}\u001b[0m'),
    ).toBe('{"type":"progress","data":{"progress":42}}');
  });

  it('extracts payload for structured PROGRESS_JSON marker', () => {
    expect(
      extractProgressPayload(
        'PROGRESS_JSON: {"type":"progress","data":{"progress":42,"message":"step"}}',
      ),
    ).toBe('{"type":"progress","data":{"progress":42,"message":"step"}}');
  });

  it('returns empty payload as empty string when only marker exists', () => {
    expect(extractProgressPayload('PROGRESS:   ')).toBe('');
  });
});

describe('extractResultPayload', () => {
  it('returns null for non-result lines', () => {
    expect(extractResultPayload('hello world')).toBeNull();
    expect(extractResultPayload('')).toBeNull();
  });

  it('extracts payload for plain result marker', () => {
    expect(extractResultPayload('RESULT_JSON: {"ok":true}')).toBe('{"ok":true}');
  });

  it('extracts payload when line has prefix text', () => {
    expect(extractResultPayload('[worker] RESULT_JSON: {"status":"success"}')).toBe(
      '{"status":"success"}',
    );
  });

  it('extracts payload when line has ANSI color codes', () => {
    expect(extractResultPayload('\u001b[32mRESULT_JSON: {"id":123}\u001b[0m')).toBe(
      '{"id":123}',
    );
  });

  it('returns empty payload as empty string when only marker exists', () => {
    expect(extractResultPayload('RESULT_JSON:   ')).toBe('');
  });
});
