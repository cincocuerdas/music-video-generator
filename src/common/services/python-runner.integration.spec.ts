import { PythonRunnerService } from './python-runner.service';

describe('PythonRunnerService RESULT_JSON contract', () => {
  const createService = () =>
    new PythonRunnerService({
      get: (key: string) => {
        if (key === 'PYTHON_PATH') {
          return process.env.PYTHON_PATH || 'python';
        }
        if (key === 'PYTHON_RUNNER_STDOUT_BUFFER_MAX_CHARS') {
          return process.env.PYTHON_RUNNER_STDOUT_BUFFER_MAX_CHARS;
        }
        if (key === 'PYTHON_RUNNER_STDERR_BUFFER_MAX_CHARS') {
          return process.env.PYTHON_RUNNER_STDERR_BUFFER_MAX_CHARS;
        }
        return undefined;
      },
    } as any);

  const service = createService();
  let loggerSpies: jest.SpyInstance[] = [];

  beforeAll(() => {
    const logger = (service as any).logger;
    loggerSpies = [
      jest.spyOn(logger, 'log').mockImplementation(() => undefined),
      jest.spyOn(logger, 'debug').mockImplementation(() => undefined),
      jest.spyOn(logger, 'warn').mockImplementation(() => undefined),
      jest.spyOn(logger, 'error').mockImplementation(() => undefined),
    ];
  });

  afterAll(() => {
    for (const spy of loggerSpies) {
      spy.mockRestore();
    }
  });

  it('prefers the last valid RESULT_JSON payload when multiple are emitted', async () => {
    const result = await service.runScript('dev-tools/python_runner_result_contract.py', [
      'latest_valid_wins',
    ]);

    expect(result).toEqual({
      source: 'explicit',
      selected: 'last',
      value: 2,
    });
  });

  it('falls back to stdout JSON when RESULT_JSON is invalid', async () => {
    const result = await service.runScript('dev-tools/python_runner_result_contract.py', [
      'invalid_then_stdout_fallback',
    ]);

    expect(result).toEqual({
      source: 'stdout',
      selected: 'fallback',
    });
  });

  it('uses valid RESULT_JSON even if a previous RESULT_JSON payload was invalid', async () => {
    const result = await service.runScript('dev-tools/python_runner_result_contract.py', [
      'invalid_then_valid',
    ]);

    expect(result).toEqual({
      source: 'explicit',
      selected: 'valid',
    });
  });

  it('truncates oversized stdout buffers instead of retaining the full output in memory', async () => {
    process.env.PYTHON_RUNNER_STDOUT_BUFFER_MAX_CHARS = '120';
    const truncatingService = createService();

    const result = await truncatingService.runScript<{ rawOutput: string }>(
      'dev-tools/python_runner_buffer_contract.py',
      ['huge_stdout_raw'],
    );

    expect(result.rawOutput).toContain('[truncated ');
    expect(result.rawOutput.length).toBeLessThanOrEqual(170);
    delete process.env.PYTHON_RUNNER_STDOUT_BUFFER_MAX_CHARS;
  });

  it('still prefers explicit RESULT_JSON even when stdout was truncated', async () => {
    process.env.PYTHON_RUNNER_STDOUT_BUFFER_MAX_CHARS = '120';
    const truncatingService = createService();

    const result = await truncatingService.runScript('dev-tools/python_runner_buffer_contract.py', [
      'huge_stdout_then_result_json',
    ]);

    expect(result).toEqual({
      source: 'explicit',
      selected: 'buffer-safe',
    });
    delete process.env.PYTHON_RUNNER_STDOUT_BUFFER_MAX_CHARS;
  });
});
