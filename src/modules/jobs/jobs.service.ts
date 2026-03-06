import { Injectable } from '@nestjs/common';
import { Job } from '@prisma/client';
import { JobCrudService } from './services/job-crud.service';
import { JobStateService } from './services/job-state.service';
import { PipelineDispatchCoordinatorService } from './services/pipeline-dispatch-coordinator.service';
import { PipelineCancellationService } from './services/pipeline-cancellation.service';
import { PipelineLifecycleService } from './services/pipeline-lifecycle.service';
import { PipelineStatusService } from './services/pipeline-status.service';
import { StyleLoraService } from './services/style-lora.service';
import { CreateJobDto, UpdateJobDto } from './types/jobs-crud.type';
import type { PipelineStatus } from './types/pipeline-status.type';

@Injectable()
export class JobsService {
  constructor(
    private readonly jobCrudService: JobCrudService,
    private readonly pipelineLifecycleService: PipelineLifecycleService,
    private readonly pipelineDispatchCoordinatorService: PipelineDispatchCoordinatorService,
    private readonly pipelineStatusService: PipelineStatusService,
    private readonly pipelineCancellationService: PipelineCancellationService,
    private readonly jobStateService: JobStateService,
    private readonly styleLoraService: StyleLoraService,
  ) {}

  async createForUser(userId: string, data: CreateJobDto): Promise<Job> {
    await this.jobCrudService.assertProjectOwnership(data.projectId, userId);
    return this.create(data);
  }

  async findOneForUser(id: string, userId: string): Promise<Job> {
    return this.jobCrudService.findOneForUser(id, userId);
  }

  async updateForUser(id: string, userId: string, data: UpdateJobDto): Promise<Job> {
    return this.jobCrudService.updateForUser(id, userId, data);
  }

  async removeForUser(id: string, userId: string): Promise<Job> {
    return this.jobCrudService.removeForUser(id, userId);
  }

  async startPipelineForUser(projectId: string, userId: string): Promise<Job[]> {
    await this.jobCrudService.assertProjectOwnership(projectId, userId);
    return this.startPipeline(projectId);
  }

  async getPipelineStatusForUser(projectId: string, userId: string): Promise<PipelineStatus> {
    await this.jobCrudService.assertProjectOwnership(projectId, userId);
    return this.getPipelineStatus(projectId);
  }

  async cancelPipelineForUser(projectId: string, userId: string): Promise<void> {
    await this.jobCrudService.assertProjectOwnership(projectId, userId);
    await this.cancelPipeline(projectId);
  }

  async create(data: CreateJobDto): Promise<Job> {
    return this.jobCrudService.create(data);
  }

  async findOne(id: string): Promise<Job> {
    return this.jobCrudService.findOne(id);
  }

  async findByProject(projectId: string): Promise<Job[]> {
    return this.jobCrudService.findByProject(projectId);
  }

  async update(id: string, data: UpdateJobDto): Promise<Job> {
    return this.jobStateService.update(id, data);
  }

  async remove(id: string): Promise<Job> {
    return this.jobCrudService.remove(id);
  }

  async markAsProcessing(id: string, workerId: string): Promise<Job> {
    return this.jobStateService.markAsProcessing(id, workerId);
  }

  async markAsCompleted(id: string, outputData: any): Promise<Job> {
    return this.jobStateService.markAsCompleted(id, outputData);
  }

  async markAsFailed(id: string, error: string): Promise<Job> {
    return this.jobStateService.markAsFailed(id, error);
  }

  async updateProgress(id: string, progress: number, currentStep?: string): Promise<Job> {
    return this.jobStateService.updateProgress(id, progress, currentStep);
  }

  async startPipeline(projectId: string): Promise<Job[]> {
    return this.pipelineLifecycleService.startPipeline(projectId, async (job) =>
      this.pipelineDispatchCoordinatorService.dispatch(job),
    );
  }

  async advancePipeline(projectId: string): Promise<Job | null> {
    return this.pipelineLifecycleService.advancePipeline(projectId, async (job) =>
      this.pipelineDispatchCoordinatorService.dispatch(job),
    );
  }

  async getPipelineStatus(projectId: string): Promise<PipelineStatus> {
    return this.pipelineStatusService.getPipelineStatus(projectId);
  }

  async cancelPipeline(projectId: string): Promise<void> {
    await this.pipelineCancellationService.cancelPipeline(projectId);
  }

  async triggerStyleLoraTraining(
    projectId: string,
    style: string,
    likesCount: number,
  ): Promise<Job | null> {
    return this.styleLoraService.triggerStyleLoraTraining(projectId, style, likesCount);
  }

  async updateStyleLoraConfig(
    style: string,
    payload: { loraFilename: string; loraPath: string; likesUsed?: number },
  ): Promise<void> {
    return this.styleLoraService.updateStyleLoraConfig(style, payload);
  }
}
