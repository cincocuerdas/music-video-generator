import { PythonRunnerService } from './python-runner.service';

describe('PythonRunnerService RESULT_JSON contract', () => {
  const configService = {
    get: (key: string) => {
      if (key === 'PYTHON_PATH') {
        return process.env.PYTHON_PATH || 'python';
      }
      return undefined;
    },
  } as any;

  const service = new PythonRunnerService(configService);
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
});
