import { Module } from '@nestjs/common';
import { QueueModule } from '../queue';
import { ObservabilityModule } from '../observability';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { HealthAlertingService } from './health-alerting.service';

@Module({
  imports: [QueueModule, ObservabilityModule],
  controllers: [HealthController],
  providers: [HealthService, HealthAlertingService],
})
export class HealthModule {}
