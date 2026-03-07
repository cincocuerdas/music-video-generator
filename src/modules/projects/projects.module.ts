import { Module, forwardRef } from '@nestjs/common';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { ProjectsRepository } from './repositories';
import { PrismaModule } from '../prisma';
import { JobsModule } from '../jobs/jobs.module';
import { EventsModule } from '../events/events.module';
import { EmbeddingsModule } from '../embeddings';
import { RedisModule } from '../redis/redis.module';
import { ProjectFeedbackService } from './services/project-feedback.service';
import { PromptOptimizationService } from './services/prompt-optimization.service';
import { LiveSteeringService } from './services/live-steering.service';

@Module({
  imports: [
    PrismaModule,
    EmbeddingsModule,
    RedisModule,
    forwardRef(() => JobsModule),
    forwardRef(() => EventsModule),
  ],
  controllers: [ProjectsController],
  providers: [
    ProjectsRepository,
    ProjectsService,
    ProjectFeedbackService,
    PromptOptimizationService,
    LiveSteeringService,
  ],
  exports: [ProjectsService],
})
export class ProjectsModule {}
