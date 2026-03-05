import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
  Injectable,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { SentryService } from '../../modules/observability';
import { toStructuredLog } from '../utils/structured-log.util';

@Catch()
@Injectable()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);
  private readonly responseEnvelopeEnabled =
    (process.env.API_RESPONSE_ENVELOPE_ENABLED || 'false').trim().toLowerCase() === 'true';

  constructor(private readonly sentryService: SentryService) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const correlationId =
      (request as Request & { correlationId?: string }).correlationId ||
      (typeof request.headers['x-correlation-id'] === 'string'
        ? request.headers['x-correlation-id']
        : undefined) ||
      null;

    // Log the full exception for debugging, ignoring harmless favicon errors
    if (request.url !== '/favicon.ico') {
      this.logger.error(
        toStructuredLog('http.exception', {
          cid: correlationId,
          method: request.method,
          url: request.url,
          exceptionType: exception instanceof Error ? exception.name : typeof exception,
          statusCode:
            exception instanceof HttpException
              ? exception.getStatus()
              : HttpStatus.INTERNAL_SERVER_ERROR,
        }),
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.sentryService.captureException(exception, {
        tags: {
          component: 'http',
          method: request.method,
          route: request.url,
          statusCode: status,
        },
        extra: {
          path: request.url,
          query: request.query,
          params: request.params,
          userAgent: request.headers['user-agent'],
        },
      });
    }

    const rawMessage =
      exception instanceof HttpException
        ? exception.getResponse()
        : 'Internal server error';
    const message = typeof rawMessage === 'string' ? rawMessage : (rawMessage as any)?.message;

    const timestamp = new Date().toISOString();
    if (this.responseEnvelopeEnabled) {
      response.status(status).json({
        ok: false,
        error: {
          statusCode: status,
          message,
        },
        meta: {
          timestamp,
          path: request.url,
          correlationId,
        },
      });
      return;
    }

    response.status(status).json({
      statusCode: status,
      timestamp,
      path: request.url,
      correlationId,
      message,
    });
  }
}
