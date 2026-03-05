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
import { DeadLetterProcessor } from './processors/dead-letter.processor';
import { PythonRunnerModule } from '../../common/services';
import { ProjectsModule } from '../projects/projects.module';
import { ObservabilityModule } from '../observability';
import { DeadLetterService } from './services/dead-letter.service';
import { StaleWatchdogService } from './services/stale-watchdog.service';
import { PipelineOrchestratorService } from './services/pipeline-orchestrator.service';
import { JobDispatchService } from './services/job-dispatch.service';
import { JobCrudService } from './services/job-crud.service';
import { JobStateService } from './services/job-state.service';
import { PipelineDispatchCoordinatorService } from './services/pipeline-dispatch-coordinator.service';
import { ProjectPipelineQualityService } from './services/project-pipeline-quality.service';
import { PipelineTransitionService } from './services/pipeline-transition.service';
import { PipelineStatusService } from './services/pipeline-status.service';
import { PipelineLifecycleService } from './services/pipeline-lifecycle.service';
import { DeadLetterOrchestratorService } from './services/dead-letter-orchestrator.service';
import { StyleLoraService } from './services/style-lora.service';
import { PipelineCancellationService } from './services/pipeline-cancellation.service';

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
    DeadLetterService,
    DeadLetterOrchestratorService,
    StaleWatchdogService,
    PipelineOrchestratorService,
    PipelineTransitionService,
    PipelineStatusService,
    PipelineLifecycleService,
    PipelineCancellationService,
    StyleLoraService,
    JobDispatchService,
    JobCrudService,
    JobStateService,
    PipelineDispatchCoordinatorService,
    ProjectPipelineQualityService,
    YouTubeDownloadProcessor,
    TranscriptionProcessor,
    AnalysisProcessor,
    ImageGenerationProcessor,
    VideoRenderProcessor,
    TrainLoraProcessor,
    DeadLetterProcessor,
  ],
  exports: [JobsService],
})
export class JobsModule { }
