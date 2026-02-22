import { Module, forwardRef } from '@nestjs/common';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { PrismaModule } from '../prisma';
import { JobsModule } from '../jobs/jobs.module';
import { EventsModule } from '../events/events.module';
import { EmbeddingsModule } from '../embeddings';

@Module({
  imports: [
    PrismaModule,
    EmbeddingsModule,
    forwardRef(() => JobsModule),
    forwardRef(() => EventsModule),
  ],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule { }
