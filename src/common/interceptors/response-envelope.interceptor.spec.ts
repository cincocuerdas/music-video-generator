import { CallHandler, ExecutionContext, StreamableFile } from '@nestjs/common';
import { Readable } from 'stream';
import { of, firstValueFrom } from 'rxjs';
import { ResponseEnvelopeInterceptor } from './response-envelope.interceptor';

function makeContext(
  url = '/api/v1/projects',
  correlationId = 'cid-test-123',
): ExecutionContext {
  const request = { url, correlationId, headers: {} };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
    }),
  } as unknown as ExecutionContext;
}

describe('ResponseEnvelopeInterceptor', () => {
  it('wraps normal object response with envelope', async () => {
    const interceptor = new ResponseEnvelopeInterceptor();
    const context = makeContext();
    const handler: CallHandler = {
      handle: () => of({ id: 'p1', status: 'ok' }),
    };

    const result = await firstValueFrom(interceptor.intercept(context, handler));
    const payload = result as {
      ok: boolean;
      data: { id: string; status: string };
      meta: { timestamp: string; correlationId?: string; path?: string };
    };

    expect(payload.ok).toBe(true);
    expect(payload.data.id).toBe('p1');
    expect(payload.meta.correlationId).toBe('cid-test-123');
    expect(payload.meta.path).toBe('/api/v1/projects');
    expect(typeof payload.meta.timestamp).toBe('string');
  });

  it('does not double-wrap an already enveloped response', async () => {
    const interceptor = new ResponseEnvelopeInterceptor();
    const context = makeContext();
    const original = {
      ok: true,
      data: { value: 42 },
      meta: { timestamp: new Date().toISOString() },
    };
    const handler: CallHandler = { handle: () => of(original) };

    const result = await firstValueFrom(interceptor.intercept(context, handler));
    expect(result).toBe(original);
  });

  it('bypasses buffer responses', async () => {
    const interceptor = new ResponseEnvelopeInterceptor();
    const context = makeContext();
    const buffer = Buffer.from('video-bytes');
    const handler: CallHandler = { handle: () => of(buffer) };

    const result = await firstValueFrom(interceptor.intercept(context, handler));
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result).toBe(buffer);
  });

  it('bypasses stream and StreamableFile responses', async () => {
    const interceptor = new ResponseEnvelopeInterceptor();
    const context = makeContext();

    const streamHandler: CallHandler = { handle: () => of(Readable.from(['hello'])) };
    const streamResult = await firstValueFrom(interceptor.intercept(context, streamHandler));
    expect((streamResult as Readable).readable).toBe(true);

    const fileHandler: CallHandler = {
      handle: () => of(new StreamableFile(Buffer.from('file-data'))),
    };
    const fileResult = await firstValueFrom(interceptor.intercept(context, fileHandler));
    expect(fileResult instanceof StreamableFile).toBe(true);
  });
});

