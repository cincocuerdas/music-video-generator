import { Controller, DefaultValuePipe, Get, ParseIntPipe, Query } from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { THROTTLE_RULES } from '../../common/constants';
import { HealthService } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @SkipThrottle({ default: true })
  check() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ops')
  @Throttle(THROTTLE_RULES.healthOps)
  async ops(): Promise<Record<string, unknown>> {
    return this.healthService.getOpsSnapshot();
  }

  @Get('ops/realtime')
  @Throttle(THROTTLE_RULES.healthOps)
  async realtime(): Promise<Record<string, unknown>> {
    return this.healthService.getRealtimeEventsSnapshot();
  }

  @Get('ops/degraded')
  @Throttle(THROTTLE_RULES.healthOpsDegraded)
  async degraded(
    @Query('hours', new DefaultValuePipe(24), ParseIntPipe) hours: number,
  ): Promise<Record<string, unknown>> {
    return this.healthService.getDegradedStageSnapshotWithAlerts(hours);
  }

  @Get('ops/pipeline-quality')
  @Throttle(THROTTLE_RULES.healthOpsDegraded)
  async pipelineQuality(
    @Query('hours', new DefaultValuePipe(24), ParseIntPipe) hours: number,
  ): Promise<Record<string, unknown>> {
    return this.healthService.getPipelineQualitySummary(hours);
  }
}
