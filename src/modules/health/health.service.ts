import { Injectable } from '@nestjs/common';
import { HealthOpsMetricsService } from './services/health-ops-metrics.service';
import { SloMitigationService, MitigationSnapshot } from './services/slo-mitigation.service';

@Injectable()
export class HealthService {
  constructor(
    private readonly healthOpsMetricsService: HealthOpsMetricsService,
    private readonly sloMitigationService: SloMitigationService,
  ) {}

  async getOpsSnapshot(includeSynthetic?: boolean): Promise<Record<string, unknown>> {
    if (typeof includeSynthetic === 'boolean') {
      return this.healthOpsMetricsService.getOpsSnapshot(includeSynthetic);
    }
    return this.healthOpsMetricsService.getOpsSnapshot();
  }

  getRealtimeEventsSnapshot(): Record<string, unknown> {
    return this.healthOpsMetricsService.getRealtimeEventsSnapshot();
  }

  async getDegradedStageSnapshot(
    hours = 24,
    sourceMode?: string,
    includeSynthetic?: boolean,
  ): Promise<Record<string, unknown>> {
    if (typeof includeSynthetic === 'boolean') {
      return this.healthOpsMetricsService.getDegradedStageSnapshot(hours, sourceMode, includeSynthetic);
    }
    return this.healthOpsMetricsService.getDegradedStageSnapshot(hours, sourceMode);
  }

  async getDegradedStageSnapshotWithAlerts(
    hours = 24,
    sourceMode?: string,
    includeSynthetic?: boolean,
  ): Promise<Record<string, unknown>> {
    if (typeof includeSynthetic === 'boolean') {
      return this.healthOpsMetricsService.getDegradedStageSnapshotWithAlerts(
        hours,
        sourceMode,
        includeSynthetic,
      );
    }
    return this.healthOpsMetricsService.getDegradedStageSnapshotWithAlerts(hours, sourceMode);
  }

  async getPipelineQualitySummary(
    hours = 24,
    sourceMode?: string,
    includeSynthetic?: boolean,
  ): Promise<Record<string, unknown>> {
    if (typeof includeSynthetic === 'boolean') {
      return this.healthOpsMetricsService.getPipelineQualitySummary(hours, sourceMode, includeSynthetic);
    }
    return this.healthOpsMetricsService.getPipelineQualitySummary(hours, sourceMode);
  }

  async getDurationByStage(hours = 24, includeSynthetic?: boolean): Promise<Record<string, unknown>> {
    if (typeof includeSynthetic === 'boolean') {
      return this.healthOpsMetricsService.getDurationByStage(hours, includeSynthetic);
    }
    return this.healthOpsMetricsService.getDurationByStage(hours);
  }

  async getDegradedRateByLanguage(
    hours = 24,
    includeSynthetic?: boolean,
  ): Promise<Record<string, unknown>> {
    if (typeof includeSynthetic === 'boolean') {
      return this.healthOpsMetricsService.getDegradedRateByLanguage(hours, includeSynthetic);
    }
    return this.healthOpsMetricsService.getDegradedRateByLanguage(hours);
  }

  async getPipelineSlo(hours = 24, includeSynthetic?: boolean): Promise<Record<string, unknown>> {
    if (typeof includeSynthetic === 'boolean') {
      return this.healthOpsMetricsService.getPipelineSlo(hours, includeSynthetic);
    }
    return this.healthOpsMetricsService.getPipelineSlo(hours);
  }

  async getQueueWaitByStage(hours = 24): Promise<Record<string, unknown>> {
    return this.healthOpsMetricsService.getQueueWaitByStage(hours);
  }

  async getPipelineSloBreakdown(
    hours = 24,
    includeSynthetic?: boolean,
  ): Promise<Record<string, unknown>> {
    if (typeof includeSynthetic === 'boolean') {
      return this.healthOpsMetricsService.getPipelineSloBreakdown(hours, includeSynthetic);
    }
    return this.healthOpsMetricsService.getPipelineSloBreakdown(hours);
  }

  getSloMitigationSnapshot(): MitigationSnapshot {
    return this.sloMitigationService.snapshot();
  }
}
