type StructuredLogPayload = Record<string, unknown>;

export function toStructuredLog(event: string, payload: StructuredLogPayload = {}): string {
  return JSON.stringify({
    event,
    at: new Date().toISOString(),
    ...payload,
  });
}

