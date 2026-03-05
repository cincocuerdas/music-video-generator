import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  StreamableFile,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';

type EnvelopeMeta = {
  timestamp: string;
  correlationId?: string;
  path?: string;
};

type Envelope<T> = {
  ok: true;
  data: T;
  meta: EnvelopeMeta;
};

function isAlreadyEnvelope(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return candidate.ok === true && 'data' in candidate && 'meta' in candidate;
}

function isStreamLike(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.pipe === 'function' || typeof candidate.on === 'function';
}

@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<{ url?: string; correlationId?: string }>();
    const correlationId =
      request?.correlationId ||
      (typeof (request as { headers?: Record<string, unknown> })?.headers?.['x-correlation-id'] ===
      'string'
        ? ((request as { headers?: Record<string, unknown> }).headers?.[
            'x-correlation-id'
          ] as string)
        : undefined);
    const path = request?.url;

    return next.handle().pipe(
      map((data) => {
        if (isAlreadyEnvelope(data)) {
          return data;
        }
        if (data instanceof StreamableFile || Buffer.isBuffer(data) || isStreamLike(data)) {
          return data;
        }

        const meta: EnvelopeMeta = {
          timestamp: new Date().toISOString(),
          correlationId,
          path,
        };

        return {
          ok: true,
          data,
          meta,
        } as Envelope<unknown>;
      }),
    );
  }
}

