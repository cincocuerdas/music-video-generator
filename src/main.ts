import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger, NestInterceptor } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { json as expressJson, urlencoded as expressUrlEncoded } from 'express';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters';
import { LoggingInterceptor, ResponseEnvelopeInterceptor } from './common/interceptors';
import { resolveCorsConfig } from './common/utils/cors.utils';
import {
  validateSecurityConfig,
  validateInfrastructureConfig,
  validateAiProviderConfig,
} from './config/validators';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const crashOnFatal = (process.env.NODE_ENV || 'development').trim().toLowerCase() === 'production';

  // Process-level crash guards.
  process.on('uncaughtException', (error) => {
    logger.error(`Uncaught exception: ${error.message}`, error.stack);
    if (crashOnFatal) {
      process.exitCode = 1;
      setImmediate(() => process.exit(1));
    }
  });
  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    logger.error(`Unhandled rejection: ${msg}`, stack);
    if (crashOnFatal) {
      process.exitCode = 1;
      setImmediate(() => process.exit(1));
    }
  });

  const app = await NestFactory.create(AppModule, {
    rawBody: true,
  });

  // Enable graceful shutdown so Nest cleans up on SIGTERM / SIGINT.
  app.enableShutdownHooks();

  const configService = app.get(ConfigService);
  validateSecurityConfig(configService, logger);
  validateInfrastructureConfig(configService);
  validateAiProviderConfig(configService);
  const helmetEnabled = (process.env.HELMET_ENABLED || 'true').trim().toLowerCase() !== 'false';
  const bodyLimit = (process.env.HTTP_BODY_LIMIT || '1mb').trim() || '1mb';
  const nodeEnv = (configService.get<string>('app.nodeEnv') || process.env.NODE_ENV || 'development')
    .trim()
    .toLowerCase();
  const swaggerEnabledByDefault = nodeEnv !== 'production';
  const swaggerEnabled = (
    process.env.SWAGGER_ENABLED || (swaggerEnabledByDefault ? 'true' : 'false')
  )
    .trim()
    .toLowerCase() !== 'false';
  const responseEnvelopeEnabled = (
    process.env.API_RESPONSE_ENVELOPE_ENABLED || 'false'
  )
    .trim()
    .toLowerCase() === 'true';
  const host = (configService.get<string>('app.host') || '0.0.0.0').trim();
  const port = configService.get<number>('app.port') ?? 3000;

  app.setGlobalPrefix('api/v1');

  if (helmetEnabled) {
    const corsOrigins = (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
    const isDev = nodeEnv === 'development';

    app.use(
      helmet({
        contentSecurityPolicy: isDev
          ? false // relaxed in dev for Swagger UI, HMR, etc.
          : {
              directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'"],
                styleSrc: ["'self'", "'unsafe-inline'"],
                imgSrc: ["'self'", 'data:', 'blob:'],
                connectSrc: ["'self'", ...corsOrigins],
                fontSrc: ["'self'"],
                objectSrc: ["'none'"],
                frameSrc: ["'none'"],
                frameAncestors: ["'none'"],
                baseUri: ["'self'"],
                formAction: ["'self'"],
              },
            },
        crossOriginEmbedderPolicy: false,
        referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      }),
    );
  }

  app.use(expressJson({ limit: bodyLimit }));
  app.use(expressUrlEncoded({ extended: true, limit: bodyLimit }));

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalFilters(app.get(AllExceptionsFilter));
  const globalInterceptors: NestInterceptor[] = [new LoggingInterceptor()];
  if (responseEnvelopeEnabled) {
    globalInterceptors.push(new ResponseEnvelopeInterceptor());
    logger.log('Response envelope interceptor enabled');
  }
  app.useGlobalInterceptors(...globalInterceptors);

  const corsOriginConfig = configService.get<string>('app.corsOrigin', '*');
  const corsConfig = resolveCorsConfig(corsOriginConfig);

  app.enableCors({
    origin: corsConfig.allowWildcard ? true : corsConfig.origins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: !corsConfig.allowWildcard,
  });

  if (swaggerEnabled) {
    const config = new DocumentBuilder()
      .setTitle('Music Video Generator API')
      .setDescription('Backend API documentation for pipeline, projects and jobs')
      .setVersion('0.1.0')
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          in: 'header',
        },
        'access-token',
      )
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document, {
      swaggerOptions: {
        persistAuthorization: nodeEnv === 'development',
      },
    });
    logger.log('Swagger docs enabled at /api/docs');
  }

  await app.listen(port, host);
  logger.log(`Application running on ${host}:${port}`);
}

bootstrap().catch((error) => {
  const logger = new Logger('Bootstrap');
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  logger.error(`Fatal bootstrap error: ${message}`, stack);
  process.exit(1);
});

