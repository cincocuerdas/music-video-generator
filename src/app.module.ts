import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ServeStaticModule } from '@nestjs/serve-static';
import { ThrottlerModule } from '@nestjs/throttler';
import { join } from 'path';
import { appConfig, databaseConfig, redisConfig } from './config';
import { PrismaModule } from './modules/prisma';
import { QueueModule } from './modules/queue';
import { RedisModule, RedisThrottlerStorageService } from './modules/redis';
import { HealthModule } from './modules/health';
import { ProjectsModule } from './modules/projects';
import { JobsModule } from './modules/jobs';
import { PythonRunnerModule, UserQuotaService } from './common/services';
import { EventsModule } from './modules/events';
import { AuthModule, JwtAuthGuard } from './modules/auth';
import { HttpThrottlerGuard } from './common/guards/http-throttler.guard';
import { UserQuotaGuard } from './common/guards/user-quota.guard';
import { ObservabilityModule } from './modules/observability';
import { AllExceptionsFilter } from './common/filters';
import { WebhooksModule } from './modules/webhooks';

const parseEnvNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, databaseConfig, redisConfig],
      envFilePath: ['.env.local', '.env'],
    }),
    ThrottlerModule.forRootAsync({
      imports: [RedisModule],
      inject: [RedisThrottlerStorageService],
      useFactory: (storage: RedisThrottlerStorageService) => ({
        storage,
        throttlers: [
          {
            name: 'default',
            ttl: parseEnvNumber(process.env.THROTTLE_TTL_MS, 60_000),
            limit: parseEnvNumber(process.env.THROTTLE_LIMIT, 120),
          },
        ],
      }),
    }),
    ServeStaticModule.forRoot({
      rootPath: join(process.cwd(), 'output'),
      serveRoot: '/output',
    }),
    PrismaModule,
    AuthModule,
    PythonRunnerModule,
    ObservabilityModule,
    QueueModule,
    RedisModule,
    HealthModule,
    WebhooksModule,
    ProjectsModule,
    JobsModule,
    EventsModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: HttpThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: UserQuotaGuard,
    },
    UserQuotaService,
    AllExceptionsFilter,
  ],
})
export class AppModule { }
