import {
    WebSocketGateway,
    WebSocketServer,
    SubscribeMessage,
    OnGatewayConnection,
    OnGatewayDisconnect,
    ConnectedSocket,
    MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../prisma';
import { AuthService } from '../auth';
import { resolveCorsConfig } from '../../common/utils/cors.utils';
import { EventsMetricsService } from './events-metrics.service';

const socketCorsOrigin = resolveCorsConfig(process.env.CORS_ORIGIN).socketOrigin;

/**
 * Pipeline Event Types for Cinematic Loader
 */
export interface PipelineEvent {
    projectId: string;
    type: 'VERSE_CLASSIFIED' | 'IMAGE_GENERATED' | 'FRAME_SKIPPED' | 'FRAME_RENDERED' | 'PIPELINE_COMPLETE';
    data: {
        url?: string;
        percent: number;
        exposed: boolean;
        sceneIndex?: number;
        totalScenes?: number;
        verseType?: string;
        reason?: string;
    };
}

@WebSocketGateway({
    cors: {
        origin: socketCorsOrigin,
    },
    namespace: '/events',
})
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
    @WebSocketServer()
    server: Server;

    private readonly logger = new Logger(EventsGateway.name);
    private readonly uuidRegex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    constructor(
        private readonly prisma: PrismaService,
        private readonly authService: AuthService,
        private readonly eventsMetrics: EventsMetricsService,
    ) {}

    private logStructured(event: string, payload: Record<string, unknown>) {
        this.logger.log(
            JSON.stringify({
                domain: 'ws',
                event,
                ...payload,
                ts: new Date().toISOString(),
            }),
        );
    }

    handleConnection(client: Socket) {
        try {
            const authenticatedUser = this.authService.authenticateSocket(client);
            client.data.userId = authenticatedUser.userId;
        } catch (error) {
            this.eventsMetrics.recordAuthFailure();
            this.logger.warn(`Rejected socket ${client.id}: invalid auth`);
            this.logStructured('connection_rejected', { socketId: client.id, reason: 'invalid_auth' });
            client.emit('auth:error', { message: 'Unauthorized' });
            client.disconnect(true);
            return;
        }

        this.eventsMetrics.recordConnectionOpened();
        this.logger.log(`Client connected: ${client.id}`);
        this.logStructured('connection_opened', { socketId: client.id });
    }

    handleDisconnect(client: Socket) {
        this.eventsMetrics.recordConnectionClosed();
        this.logger.log(`Client disconnected: ${client.id}`);
        this.logStructured('connection_closed', { socketId: client.id });
    }

    @SubscribeMessage('join:project')
    async handleJoinProject(
        @ConnectedSocket() client: Socket,
        @MessageBody() data: { projectId: string },
    ) {
        if (!data?.projectId || !this.uuidRegex.test(data.projectId)) {
            this.eventsMetrics.recordJoinAttempt('invalid');
            this.logger.warn(`Client ${client.id} attempted to join invalid project room`);
            this.logStructured('join_rejected', { socketId: client.id, reason: 'invalid_project_id' });
            return { success: false, error: 'Invalid projectId' };
        }

        const userId =
            typeof client.data.userId === 'string' && this.uuidRegex.test(client.data.userId)
                ? client.data.userId
                : null;
        if (!userId) {
            this.eventsMetrics.recordJoinAttempt('denied');
            this.logger.warn(`Client ${client.id} missing user context for join:project`);
            this.logStructured('join_rejected', { socketId: client.id, reason: 'missing_user_context' });
            return { success: false, error: 'Missing user context' };
        }

        const project = await this.prisma.project.findFirst({
            where: { id: data.projectId, userId },
            select: { id: true },
        });

        if (!project) {
            this.eventsMetrics.recordJoinAttempt('denied');
            this.logger.warn(
                `Client ${client.id} denied join for project ${data.projectId} (user ${userId})`,
            );
            this.logStructured('join_rejected', {
                socketId: client.id,
                projectId: data.projectId,
                userId,
                reason: 'project_not_found',
            });
            return { success: false, error: 'Project not found' };
        }

        const room = `project:${data.projectId}`;
        client.join(room);
        this.eventsMetrics.recordJoinAttempt('success');
        this.logger.log(`Client ${client.id} joined room ${room}`);
        this.logStructured('join_success', { socketId: client.id, projectId: data.projectId, room });
        return { success: true, room };
    }

    @SubscribeMessage('leave:project')
    handleLeaveProject(
        @ConnectedSocket() client: Socket,
        @MessageBody() data: { projectId: string },
    ) {
        const room = `project:${data.projectId}`;
        client.leave(room);
        this.eventsMetrics.recordLeave();
        this.logger.log(`Client ${client.id} left room ${room}`);
        this.logStructured('leave', { socketId: client.id, projectId: data.projectId, room });
        return { success: true };
    }

    /**
     * Emit event when an image is generated
     */
    emitImageGenerated(
        projectId: string,
        data: {
            sceneIndex: number;
            totalScenes: number;
            imageUrl: string;
            prompt: string;
        },
    ) {
        const room = `project:${projectId}`;
        this.eventsMetrics.recordEmitted('image:generated');
        this.server.to(room).emit('image:generated', {
            projectId,
            ...data,
            timestamp: new Date().toISOString(),
        });
        this.logger.debug(
            `Emitted image:generated for project ${projectId}, scene ${data.sceneIndex}/${data.totalScenes}`,
        );
    }

    /**
     * Emit event for job status updates
     */
    emitJobUpdate(
        projectId: string,
        data: {
            jobType: string;
            status: string;
            progress: number;
            currentStep?: string;
        },
    ) {
        const room = `project:${projectId}`;
        this.eventsMetrics.recordEmitted('job:update');
        this.server.to(room).emit('job:update', {
            projectId,
            ...data,
            timestamp: new Date().toISOString(),
        });
    }

    /**
     * Emit event when generation is complete
     */
    emitGenerationComplete(projectId: string, videoUrl: string) {
        const room = `project:${projectId}`;
        this.eventsMetrics.recordEmitted('generation:complete');
        this.server.to(room).emit('generation:complete', {
            projectId,
            videoUrl,
            timestamp: new Date().toISOString(),
        });
        this.logger.log(`Emitted generation:complete for project ${projectId}`);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CINEMATIC LOADER EVENTS
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Emit pipeline progress event (unified event for Cinematic Loader)
     * Includes exposed flag for crank animation control
     */
    emitPipelineProgress(projectId: string, event: Omit<PipelineEvent, 'projectId'>) {
        const room = `project:${projectId}`;
        const payload: PipelineEvent = {
            projectId,
            ...event,
        };

        this.eventsMetrics.recordEmitted(`pipeline:${event.type}`);
        this.server.to(room).emit('pipeline:progress', payload);
        this.logger.debug(
            `[${event.type}] project:${projectId} - ${event.data.percent}% exposed:${event.data.exposed}`,
        );
    }

    /**
     * Emit when a verse has been classified
     * Crank moves slowly, no frame exposed
     */
    emitVerseClassified(
        projectId: string,
        data: { verseType: string; sceneIndex: number; totalScenes: number; percent: number },
    ) {
        this.emitPipelineProgress(projectId, {
            type: 'VERSE_CLASSIFIED',
            data: {
                percent: data.percent,
                exposed: false, // Never exposes a frame
                sceneIndex: data.sceneIndex,
                totalScenes: data.totalScenes,
                verseType: data.verseType,
            },
        });
    }

    /**
     * Emit when an image is generated AND passes quality check
     * Crank spins, frame is exposed, counter increments
     */
    emitImageExposed(
        projectId: string,
        data: {
            url: string;
            sceneIndex: number;
            totalScenes: number;
            percent: number;
            verseType?: string;
        },
    ) {
        this.emitPipelineProgress(projectId, {
            type: 'IMAGE_GENERATED',
            data: {
                url: data.url,
                percent: data.percent,
                exposed: true, // Frame IS exposed
                sceneIndex: data.sceneIndex,
                totalScenes: data.totalScenes,
                verseType: data.verseType,
            },
        });
    }

    /**
     * Emit when an image is generated but FAILS quality check
     * Crank pauses, no frame exposed
     */
    emitFrameSkipped(
        projectId: string,
        data: {
            sceneIndex: number;
            totalScenes: number;
            percent: number;
            reason: string;
        },
    ) {
        this.emitPipelineProgress(projectId, {
            type: 'FRAME_SKIPPED',
            data: {
                percent: data.percent,
                exposed: false, // Frame NOT exposed
                sceneIndex: data.sceneIndex,
                totalScenes: data.totalScenes,
                reason: data.reason,
            },
        });
    }

    /**
     * Emit when a frame has been rendered to video
     */
    emitFrameRendered(
        projectId: string,
        data: { sceneIndex: number; totalScenes: number; percent: number },
    ) {
        this.emitPipelineProgress(projectId, {
            type: 'FRAME_RENDERED',
            data: {
                percent: data.percent,
                exposed: true,
                sceneIndex: data.sceneIndex,
                totalScenes: data.totalScenes,
            },
        });
    }

    /**
     * Emit when entire pipeline is complete
     */
    emitPipelineComplete(projectId: string, videoUrl: string) {
        this.emitPipelineProgress(projectId, {
            type: 'PIPELINE_COMPLETE',
            data: {
                url: videoUrl,
                percent: 100,
                exposed: true,
            },
        });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // LIVE STEERING EVENTS
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Emit when a steering signal has been processed by Python
     * Provides feedback to user that their direction was applied
     */
    emitSteeringApplied(
        projectId: string,
        data: {
            signalType: string;
            sceneIndex: number;
            message: string;
            modifications?: {
                cfg?: number;
                seed?: number;
                prompt_modified?: boolean;
            };
        },
    ) {
        const room = `project:${projectId}`;
        this.eventsMetrics.recordEmitted('steering:applied');
        this.server.to(room).emit('steering:applied', {
            projectId,
            ...data,
            timestamp: new Date().toISOString(),
        });
        this.logger.log(
            `🎬 Emitted steering:applied for project ${projectId} - ${data.signalType} at scene ${data.sceneIndex}`,
        );
    }

    /**
     * Emit immediate acknowledgment when backend receives a steering signal
     * Provides instant feedback before Python processes it
     */
    emitSteeringReceived(
        projectId: string,
        data: {
            signalType: string;
            sceneIndex: number;
            status: string;
        },
    ) {
        const room = `project:${projectId}`;
        this.eventsMetrics.recordEmitted('steering:received');
        this.server.to(room).emit('steering:received', {
            projectId,
            ...data,
            timestamp: new Date().toISOString(),
        });
        this.logger.log(
            `🎬 Emitted steering:received for project ${projectId} - ${data.signalType} queued`,
        );
    }
}
