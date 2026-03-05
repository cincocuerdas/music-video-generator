import { Controller, DefaultValuePipe, Get, ParseIntPipe, Query } from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { THROTTLE_RULES } from '../../common/constants';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiEnvelopeDefaultErrorResponses,
  ApiEnvelopeOkResponse,
} from '../../common/swagger/api-envelope.decorators';
import { HealthService } from './health.service';

@Controller('health')
@ApiTags('health')
@ApiEnvelopeDefaultErrorResponses({ badRequest: true })
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @SkipThrottle({ default: true })
  @ApiOperation({ summary: 'Basic health check endpoint' })
  @ApiEnvelopeOkResponse('Basic health status')
  check() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ops')
  @Throttle(THROTTLE_RULES.healthOps)
  @ApiOperation({ summary: 'Operational snapshot (aggregated metrics)' })
  @ApiEnvelopeOkResponse('Operational snapshot')
  async ops(): Promise<Record<string, unknown>> {
    return this.healthService.getOpsSnapshot();
  }

  @Get('ops/realtime')
  @Throttle(THROTTLE_RULES.healthOps)
  @ApiOperation({ summary: 'Realtime events snapshot from websocket metrics cache' })
  @ApiEnvelopeOkResponse('Realtime events snapshot')
  async realtime(): Promise<Record<string, unknown>> {
    return this.healthService.getRealtimeEventsSnapshot();
  }

  @Get('ops/degraded')
  @Throttle(THROTTLE_RULES.healthOpsDegraded)
  @ApiOperation({ summary: 'Degraded rate by stage with optional source mode filter' })
  @ApiEnvelopeOkResponse('Degraded stage metrics')
  async degraded(
    @Query('hours', new DefaultValuePipe(24), ParseIntPipe) hours: number,
    @Query('sourceMode') sourceMode?: string,
  ): Promise<Record<string, unknown>> {
    return this.healthService.getDegradedStageSnapshotWithAlerts(hours, sourceMode);
  }

  @Get('ops/pipeline-quality')
  @Throttle(THROTTLE_RULES.healthOpsDegraded)
  @ApiOperation({ summary: 'Pipeline quality summary (success/degraded/failed mix)' })
  @ApiEnvelopeOkResponse('Pipeline quality summary')
  async pipelineQuality(
    @Query('hours', new DefaultValuePipe(24), ParseIntPipe) hours: number,
    @Query('sourceMode') sourceMode?: string,
  ): Promise<Record<string, unknown>> {
    return this.healthService.getPipelineQualitySummary(hours, sourceMode);
  }

  @Get('ops/duration-by-stage')
  @Throttle(THROTTLE_RULES.healthOps)
  @ApiOperation({ summary: 'Per-stage duration percentiles (avg, p50, p95, max)' })
  @ApiEnvelopeOkResponse('Duration by stage')
  async durationByStage(
    @Query('hours', new DefaultValuePipe(24), ParseIntPipe) hours: number,
  ): Promise<Record<string, unknown>> {
    return this.healthService.getDurationByStage(hours);
  }

  @Get('ops/degraded-by-language')
  @Throttle(THROTTLE_RULES.healthOps)
  @ApiOperation({ summary: 'Degraded rate grouped by detected language' })
  @ApiEnvelopeOkResponse('Degraded rates grouped by language')
  async degradedByLanguage(
    @Query('hours', new DefaultValuePipe(24), ParseIntPipe) hours: number,
  ): Promise<Record<string, unknown>> {
    return this.healthService.getDegradedRateByLanguage(hours);
  }

  @Get('ops/pipeline-slo')
  @Throttle(THROTTLE_RULES.healthOps)
  @ApiOperation({ summary: 'Full pipeline SLO (p95 latency threshold + alerts)' })
  @ApiEnvelopeOkResponse('Pipeline SLO snapshot')
  async pipelineSlo(
    @Query('hours', new DefaultValuePipe(24), ParseIntPipe) hours: number,
  ): Promise<Record<string, unknown>> {
    return this.healthService.getPipelineSlo(hours);
  }

  @Get('ops/queue-wait-by-stage')
  @Throttle(THROTTLE_RULES.healthOps)
  @ApiOperation({ summary: 'Queue wait percentiles by stage (completed wait + current pending age)' })
  @ApiEnvelopeOkResponse('Queue wait by stage')
  async queueWaitByStage(
    @Query('hours', new DefaultValuePipe(24), ParseIntPipe) hours: number,
  ): Promise<Record<string, unknown>> {
    return this.healthService.getQueueWaitByStage(hours);
  }

  @Get('ops/pipeline-slo-breakdown')
  @Throttle(THROTTLE_RULES.healthOps)
  @ApiOperation({ summary: 'Top slow pipelines with per-stage duration, retries and handoff waits' })
  @ApiEnvelopeOkResponse('Pipeline SLO breakdown')
  async pipelineSloBreakdown(
    @Query('hours', new DefaultValuePipe(24), ParseIntPipe) hours: number,
  ): Promise<Record<string, unknown>> {
    return this.healthService.getPipelineSloBreakdown(hours);
  }

  @Get('ops/slo-mitigation')
  @Throttle(THROTTLE_RULES.healthOps)
  @ApiOperation({ summary: 'Current SLO auto-mitigation status' })
  @ApiEnvelopeOkResponse('SLO auto-mitigation status')
  sloMitigation(): Record<string, unknown> {
    return this.healthService.getSloMitigationSnapshot() as unknown as Record<string, unknown>;
  }

}
