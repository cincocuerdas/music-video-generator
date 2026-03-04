import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { randomUUID } from 'crypto';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(LoggingInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const http = context.switchToHttp();
    const request = http.getRequest();
    const response = http.getResponse();
    const correlationIdHeader =
      request?.headers?.['x-correlation-id'] || request?.headers?.['x-request-id'];
    const correlationId =
      typeof correlationIdHeader === 'string' && correlationIdHeader.trim()
        ? correlationIdHeader.trim()
        : `req-${randomUUID().slice(0, 12)}`;

    request.correlationId = correlationId;
    if (response?.setHeader) {
      response.setHeader('x-correlation-id', correlationId);
    }

    const { method, url } = request;
    const now = Date.now();

    return next.handle().pipe(
      tap(() => {
        const responseTime = Date.now() - now;
        this.logger.log(
          JSON.stringify({
            event: 'http.request',
            cid: correlationId,
            method,
            url,
            statusCode: response?.statusCode,
            durationMs: responseTime,
          }),
        );
      }),
    );
  }
}
