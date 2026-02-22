import { Module, Global } from '@nestjs/common';
import { EventsGateway } from './events.gateway';
import { EventsService } from './events.service';
import { EventsMetricsService } from './events-metrics.service';

@Global()
@Module({
    providers: [EventsGateway, EventsService, EventsMetricsService],
    exports: [EventsGateway, EventsService, EventsMetricsService],
})
export class EventsModule {}
