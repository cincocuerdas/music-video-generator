import { Injectable } from '@nestjs/common';

export interface EventsMetricsSnapshot {
  activeConnections: number;
  totalConnections: number;
  totalDisconnections: number;
  authFailures: number;
  joinRequests: number;
  joinSuccess: number;
  joinDenied: number;
  joinInvalid: number;
  leaveRequests: number;
  inboundMessages: number;
  inboundParseErrors: number;
  emittedEvents: number;
  emittedByType: Record<string, number>;
  inboundByType: Record<string, number>;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class EventsMetricsService {
  private activeConnections = 0;
  private totalConnections = 0;
  private totalDisconnections = 0;
  private authFailures = 0;
  private joinRequests = 0;
  private joinSuccess = 0;
  private joinDenied = 0;
  private joinInvalid = 0;
  private leaveRequests = 0;
  private inboundMessages = 0;
  private inboundParseErrors = 0;
  private emittedEvents = 0;
  private readonly emittedByType: Record<string, number> = {};
  private readonly inboundByType: Record<string, number> = {};
  private readonly createdAt = new Date();
  private updatedAt = new Date();

  recordConnectionOpened(): void {
    this.activeConnections += 1;
    this.totalConnections += 1;
    this.touch();
  }

  recordConnectionClosed(): void {
    this.activeConnections = Math.max(0, this.activeConnections - 1);
    this.totalDisconnections += 1;
    this.touch();
  }

  recordAuthFailure(): void {
    this.authFailures += 1;
    this.touch();
  }

  recordJoinAttempt(result: 'success' | 'denied' | 'invalid'): void {
    this.joinRequests += 1;
    if (result === 'success') {
      this.joinSuccess += 1;
    } else if (result === 'denied') {
      this.joinDenied += 1;
    } else {
      this.joinInvalid += 1;
    }
    this.touch();
  }

  recordLeave(): void {
    this.leaveRequests += 1;
    this.touch();
  }

  recordInbound(type: string): void {
    this.inboundMessages += 1;
    this.inboundByType[type] = (this.inboundByType[type] || 0) + 1;
    this.touch();
  }

  recordInboundParseError(): void {
    this.inboundParseErrors += 1;
    this.touch();
  }

  recordEmitted(type: string): void {
    this.emittedEvents += 1;
    this.emittedByType[type] = (this.emittedByType[type] || 0) + 1;
    this.touch();
  }

  snapshot(): EventsMetricsSnapshot {
    return {
      activeConnections: this.activeConnections,
      totalConnections: this.totalConnections,
      totalDisconnections: this.totalDisconnections,
      authFailures: this.authFailures,
      joinRequests: this.joinRequests,
      joinSuccess: this.joinSuccess,
      joinDenied: this.joinDenied,
      joinInvalid: this.joinInvalid,
      leaveRequests: this.leaveRequests,
      inboundMessages: this.inboundMessages,
      inboundParseErrors: this.inboundParseErrors,
      emittedEvents: this.emittedEvents,
      emittedByType: { ...this.emittedByType },
      inboundByType: { ...this.inboundByType },
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
    };
  }

  private touch(): void {
    this.updatedAt = new Date();
  }
}
