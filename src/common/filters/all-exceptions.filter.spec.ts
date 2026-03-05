import { ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';

function makeHost(reqOverrides: Record<string, unknown> = {}) {
  const request = {
    url: '/api/v1/projects',
    method: 'GET',
    query: {},
    params: {},
    headers: {},
    ...reqOverrides,
  } as any;

  const responsePayload: { statusCode?: number; body?: unknown } = {};
  const response = {
    status: jest.fn((statusCode: number) => {
      responsePayload.statusCode = statusCode;
      return response;
    }),
    json: jest.fn((body: unknown) => {
      responsePayload.body = body;
      return response;
    }),
  } as any;

  const host = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;

  return { host, request, response, responsePayload };
}

describe('AllExceptionsFilter', () => {
  const originalEnv = process.env.API_RESPONSE_ENVELOPE_ENABLED;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.API_RESPONSE_ENVELOPE_ENABLED;
    } else {
      process.env.API_RESPONSE_ENVELOPE_ENABLED = originalEnv;
    }
    jest.restoreAllMocks();
  });

  it('returns legacy error shape when envelope flag is disabled', () => {
    process.env.API_RESPONSE_ENVELOPE_ENABLED = 'false';
    const sentry = { captureException: jest.fn() } as any;
    const filter = new AllExceptionsFilter(sentry);
    const { host, responsePayload } = makeHost({
      headers: { 'x-correlation-id': 'cid-legacy' },
    });

    const exception = new HttpException('Invalid token', HttpStatus.UNAUTHORIZED);
    filter.catch(exception, host);

    expect(responsePayload.statusCode).toBe(HttpStatus.UNAUTHORIZED);
    expect(responsePayload.body).toMatchObject({
      statusCode: HttpStatus.UNAUTHORIZED,
      path: '/api/v1/projects',
      correlationId: 'cid-legacy',
      message: 'Invalid token',
    });
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('returns envelope error shape when envelope flag is enabled', () => {
    process.env.API_RESPONSE_ENVELOPE_ENABLED = 'true';
    const sentry = { captureException: jest.fn() } as any;
    const filter = new AllExceptionsFilter(sentry);
    const { host, responsePayload } = makeHost({
      headers: { 'x-correlation-id': 'cid-env' },
    });

    const exception = new HttpException('Bad input', HttpStatus.BAD_REQUEST);
    filter.catch(exception, host);

    expect(responsePayload.statusCode).toBe(HttpStatus.BAD_REQUEST);
    expect(responsePayload.body).toMatchObject({
      ok: false,
      error: {
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'Bad input',
      },
      meta: {
        path: '/api/v1/projects',
        correlationId: 'cid-env',
      },
    });
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('captures 5xx errors in Sentry and returns envelope when enabled', () => {
    process.env.API_RESPONSE_ENVELOPE_ENABLED = 'true';
    const sentry = { captureException: jest.fn() } as any;
    const filter = new AllExceptionsFilter(sentry);
    const { host, responsePayload } = makeHost({
      headers: { 'x-correlation-id': 'cid-500' },
    });

    const error = new Error('unexpected crash');
    filter.catch(error, host);

    expect(responsePayload.statusCode).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(responsePayload.body).toMatchObject({
      ok: false,
      error: {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      },
      meta: {
        correlationId: 'cid-500',
      },
    });
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  });
});

