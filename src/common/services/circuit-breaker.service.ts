import { Injectable } from '@nestjs/common';
import { parsePositiveIntEnv } from '../utils/env-parsers';

type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitEntry {
  key: string;
  state: CircuitState;
  failureCount: number;
  successCount: number;
  openedAt: string | null;
  lastFailureAt: string | null;
  lastFailureMessage: string | null;
  retryAfterMs: number;
}

interface CircuitRuntimeEntry {
  state: CircuitState;
  failureCount: number;
  successCount: number;
  openedAtMs: number | null;
  lastFailureAtMs: number | null;
  lastFailureMessage: string | null;
}

@Injectable()
export class CircuitBreakerService {
  private readonly entries = new Map<string, CircuitRuntimeEntry>();
  private readonly failureThreshold = parsePositiveIntEnv(
    'CIRCUIT_BREAKER_FAILURE_THRESHOLD',
    3,
  );
  private readonly cooldownMs = parsePositiveIntEnv(
    'CIRCUIT_BREAKER_COOLDOWN_MS',
    60_000,
  );

  canExecute(key: string): { allowed: boolean; retryAfterMs: number; state: CircuitState } {
    const now = Date.now();
    const entry = this.getOrCreateEntry(key);

    if (entry.state === 'open') {
      const openedAtMs = entry.openedAtMs ?? now;
      const elapsed = Math.max(0, now - openedAtMs);
      const retryAfterMs = Math.max(0, this.cooldownMs - elapsed);

      if (retryAfterMs === 0) {
        entry.state = 'half-open';
        entry.openedAtMs = null;
        return { allowed: true, retryAfterMs: 0, state: entry.state };
      }

      return { allowed: false, retryAfterMs, state: entry.state };
    }

    return { allowed: true, retryAfterMs: 0, state: entry.state };
  }

  recordFailure(key: string, message?: string): void {
    const now = Date.now();
    const entry = this.getOrCreateEntry(key);

    entry.failureCount += 1;
    entry.lastFailureAtMs = now;
    entry.lastFailureMessage = message ?? null;

    if (entry.failureCount >= this.failureThreshold) {
      entry.state = 'open';
      entry.openedAtMs = now;
    }
  }

  recordSuccess(key: string): void {
    const entry = this.getOrCreateEntry(key);
    entry.successCount += 1;
    entry.failureCount = 0;
    entry.state = 'closed';
    entry.openedAtMs = null;
    entry.lastFailureMessage = null;
  }

  snapshot(): {
    generatedAt: string;
    failureThreshold: number;
    cooldownMs: number;
    entries: CircuitEntry[];
  } {
    const now = Date.now();
    const entries = Array.from(this.entries.entries())
      .map(([key, value]) => ({
        key,
        state: value.state,
        failureCount: value.failureCount,
        successCount: value.successCount,
        openedAt: value.openedAtMs ? new Date(value.openedAtMs).toISOString() : null,
        lastFailureAt: value.lastFailureAtMs
          ? new Date(value.lastFailureAtMs).toISOString()
          : null,
        lastFailureMessage: value.lastFailureMessage,
        retryAfterMs:
          value.state === 'open' && value.openedAtMs
            ? Math.max(0, this.cooldownMs - Math.max(0, now - value.openedAtMs))
            : 0,
      }))
      .sort((a, b) => a.key.localeCompare(b.key));

    return {
      generatedAt: new Date(now).toISOString(),
      failureThreshold: this.failureThreshold,
      cooldownMs: this.cooldownMs,
      entries,
    };
  }

  private getOrCreateEntry(key: string): CircuitRuntimeEntry {
    const existing = this.entries.get(key);
    if (existing) {
      return existing;
    }

    const created: CircuitRuntimeEntry = {
      state: 'closed',
      failureCount: 0,
      successCount: 0,
      openedAtMs: null,
      lastFailureAtMs: null,
      lastFailureMessage: null,
    };
    this.entries.set(key, created);
    return created;
  }

}
