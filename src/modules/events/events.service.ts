import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { EventsGateway, PipelineEvent } from './events.gateway';
import { RedisClientService } from '../redis';
import { EventsMetricsService } from './events-metrics.service';

/**
 * Redis Pub/Sub message from Python pipeline
 */
interface RedisPipelineMessage {
    projectId: string;
    type: 'image_generated' | 'frame_skipped' | 'progress' | 'verse_classified' | 'steering_applied' | 'steering_received';
    data: {
        sceneIndex?: number;
        totalScenes?: number;
        imageUrl?: string;
        prompt?: string;
        progress?: number;
        message?: string;
        jobType?: string;
        exposed?: boolean;
        reason?: string;
        verseType?: string;
        // Steering-specific fields
        signalType?: 'boost' | 'correct';
        modifications?: {
            cfg?: number;
            seed?: number;
            prompt_modified?: boolean;
        };
        timestamp?: number;
    };
}

@Injectable()
export class EventsService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(EventsService.name);
    private subscriber: Redis | null = null;
    private publisher: Redis | null = null;
    private readonly CHANNEL = 'job_events';

    constructor(
        private readonly eventsGateway: EventsGateway,
        private readonly redisClientService: RedisClientService,
        private readonly eventsMetrics: EventsMetricsService,
    ) {}

    async onModuleInit() {
        await this.connectRedis();
    }

    async onModuleDestroy() {
        await this.disconnectRedis();
    }

    private async connectRedis() {
        try {
            this.subscriber = this.redisClientService.createClient('events-subscriber');
            this.publisher = this.redisClientService.createClient('events-publisher');

            // Subscribe to job events channel
            await this.subscriber.subscribe(this.CHANNEL);
            this.logger.log(`Subscribed to Redis channel: ${this.CHANNEL}`);

            // Handle incoming messages
            this.subscriber.on('message', (channel, message) => {
                if (channel === this.CHANNEL) {
                    this.handlePipelineMessage(message);
                }
            });
        } catch (error) {
            this.logger.error(`Failed to connect to Redis: ${error.message}`);
        }
    }

    private async disconnectRedis() {
        if (this.subscriber) {
            try {
                await this.subscriber.unsubscribe(this.CHANNEL);
            } catch (error) {
                this.logger.warn(
                    `Failed to unsubscribe Redis channel ${this.CHANNEL}: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
            await this.redisClientService.releaseClient(this.subscriber, 'events-subscriber');
            this.subscriber = null;
        }

        if (this.publisher) {
            await this.redisClientService.releaseClient(this.publisher, 'events-publisher');
            this.publisher = null;
        }
    }

    /**
     * Handle incoming pipeline messages from Python
     */
    private handlePipelineMessage(rawMessage: string) {
        try {
            const message: RedisPipelineMessage = JSON.parse(rawMessage);
            const { projectId, type, data } = message;
            this.eventsMetrics.recordInbound(type);

            if (!projectId) {
                this.logger.warn('Received message without projectId, ignoring');
                return;
            }

            this.logger.debug(`[${type}] project:${projectId} - ${JSON.stringify(data)}`);

            switch (type) {
                case 'image_generated':
                    this.handleImageGenerated(projectId, data);
                    break;

                case 'frame_skipped':
                    this.handleFrameSkipped(projectId, data);
                    break;

                case 'verse_classified':
                    this.handleVerseClassified(projectId, data);
                    break;

                case 'progress':
                    this.handleProgress(projectId, data);
                    break;

                case 'steering_applied':
                    this.handleSteeringApplied(projectId, data);
                    break;

                case 'steering_received':
                    this.handleSteeringReceived(projectId, data);
                    break;

                default:
                    this.logger.warn(`Unknown message type: ${type}`);
            }
        } catch (error) {
            this.eventsMetrics.recordInboundParseError();
            this.logger.error(`Failed to parse Redis message: ${error.message}`);
        }
    }

    /**
     * Handle IMAGE_GENERATED event from Python
     * Check exposed flag and emit appropriate event
     */
    private handleImageGenerated(
        projectId: string,
        data: RedisPipelineMessage['data'],
    ) {
        const percent = this.calculatePercent(data.sceneIndex, data.totalScenes);

        // Check if frame was exposed (passed quality check)
        if (data.exposed !== false) {
            // Default to exposed if not specified
            this.eventsGateway.emitImageExposed(projectId, {
                url: data.imageUrl || '',
                sceneIndex: data.sceneIndex || 0,
                totalScenes: data.totalScenes || 1,
                percent,
                verseType: data.verseType,
            });
        } else {
            // Frame was skipped due to quality check
            this.eventsGateway.emitFrameSkipped(projectId, {
                sceneIndex: data.sceneIndex || 0,
                totalScenes: data.totalScenes || 1,
                percent,
                reason: data.reason || 'Quality check failed',
            });
        }

        // Also emit legacy event for backwards compatibility
        this.eventsGateway.emitImageGenerated(projectId, {
            sceneIndex: data.sceneIndex || 0,
            totalScenes: data.totalScenes || 1,
            imageUrl: data.imageUrl || '',
            prompt: data.prompt || '',
        });
    }

    /**
     * Handle FRAME_SKIPPED event from Python
     */
    private handleFrameSkipped(
        projectId: string,
        data: RedisPipelineMessage['data'],
    ) {
        const percent = this.calculatePercent(data.sceneIndex, data.totalScenes);

        this.eventsGateway.emitFrameSkipped(projectId, {
            sceneIndex: data.sceneIndex || 0,
            totalScenes: data.totalScenes || 1,
            percent,
            reason: data.reason || 'Frame skipped',
        });
    }

    /**
     * Handle VERSE_CLASSIFIED event from Python
     */
    private handleVerseClassified(
        projectId: string,
        data: RedisPipelineMessage['data'],
    ) {
        const percent = this.calculatePercent(data.sceneIndex, data.totalScenes);

        this.eventsGateway.emitVerseClassified(projectId, {
            verseType: data.verseType || 'NARRATIVE',
            sceneIndex: data.sceneIndex || 0,
            totalScenes: data.totalScenes || 1,
            percent,
        });
    }

    /**
     * Handle generic PROGRESS event from Python
     */
    private handleProgress(
        projectId: string,
        data: RedisPipelineMessage['data'],
    ) {
        this.eventsGateway.emitJobUpdate(projectId, {
            jobType: data.jobType || 'GENERATE_IMAGES',
            status: 'processing',
            progress: data.progress || 0,
            currentStep: data.message,
        });
    }

    /**
     * Handle STEERING_APPLIED event from Python
     * Notifies frontend that a live signal was processed
     */
    private handleSteeringApplied(
        projectId: string,
        data: RedisPipelineMessage['data'],
    ) {
        this.logger.log(
            `🎬 Steering applied for project ${projectId}: ${data.signalType} at scene ${data.sceneIndex}`,
        );

        this.eventsGateway.emitSteeringApplied(projectId, {
            signalType: data.signalType || 'unknown',
            sceneIndex: data.sceneIndex || 0,
            message: data.message || 'Direction applied',
            modifications: data.modifications,
        });
    }

    /**
     * Handle STEERING_RECEIVED event
     * Immediate acknowledgment when backend receives a signal
     */
    private handleSteeringReceived(
        projectId: string,
        data: RedisPipelineMessage['data'],
    ) {
        this.logger.log(
            `🎬 Steering signal received for project ${projectId}: ${data.signalType}`,
        );

        this.eventsGateway.emitSteeringReceived(projectId, {
            signalType: data.signalType || 'unknown',
            sceneIndex: data.sceneIndex || 0,
            status: 'queued',
        });
    }

    /**
     * Calculate percentage from scene index
     */
    private calculatePercent(sceneIndex?: number, totalScenes?: number): number {
        if (!totalScenes || totalScenes === 0) return 0;
        return Math.round(((sceneIndex || 0) + 1) / totalScenes * 100);
    }

    /**
     * Publish event to Redis (for Python to consume if needed)
     */
    async publishEvent(channel: string, event: PipelineEvent) {
        if (!this.publisher) {
            this.logger.warn(
                `Redis publisher not initialized. Skipping publish to ${channel}: ${event.type}`,
            );
            return;
        }

        await this.publisher.publish(channel, JSON.stringify(event));
        this.logger.debug(`Published to ${channel}: ${event.type}`);
    }
}
