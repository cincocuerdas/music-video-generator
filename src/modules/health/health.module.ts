import { Module } from '@nestjs/common';
import { PythonRunnerModule } from '../../common/services';
import { QueueModule } from '../queue';
import { ObservabilityModule } from '../observability';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { HealthAlertingService } from './health-alerting.service';
import { HealthOpsMetricsService } from './services/health-ops-metrics.service';
import { SloMitigationService } from './services/slo-mitigation.service';

@Module({
  imports: [QueueModule, ObservabilityModule, PythonRunnerModule],
  controllers: [HealthController],
  providers: [HealthService, HealthAlertingService, HealthOpsMetricsService, SloMitigationService],
  exports: [SloMitigationService],
})
export class HealthModule {}
