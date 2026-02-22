import { Module, forwardRef } from '@nestjs/common';
import { JobsService } from './jobs.service';
import { JobsController } from './jobs.controller';
import { PrismaModule } from '../prisma';
import { QueueModule } from '../queue';
import { YouTubeDownloadProcessor } from './processors/youtube-download.processor';
import { TranscriptionProcessor } from './processors/transcription.processor';
import { AnalysisProcessor } from './processors/analysis.processor';
import { ImageGenerationProcessor } from './processors/image-generation.processor';
import { VideoRenderProcessor } from './processors/video-render.processor';
import { TrainLoraProcessor } from './processors/train-lora.processor';
import { PythonRunnerModule } from '../../common/services';
import { ProjectsModule } from '../projects/projects.module';
import { ObservabilityModule } from '../observability';

@Module({
  imports: [
    PrismaModule,
    QueueModule,
    PythonRunnerModule,
    ObservabilityModule,
    forwardRef(() => ProjectsModule),  // For AI Learning optimization
  ],
  controllers: [JobsController],
  providers: [
    JobsService,
    YouTubeDownloadProcessor,
    TranscriptionProcessor,
    AnalysisProcessor,
    ImageGenerationProcessor,
    VideoRenderProcessor,
    TrainLoraProcessor,
  ],
  exports: [JobsService],
})
export class JobsModule { }
