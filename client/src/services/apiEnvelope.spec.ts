import { unwrapData, unwrapError } from './apiEnvelope';

describe('apiEnvelope', () => {
  // ── unwrapData ────────────────────────────────────────────────────────────────

  describe('unwrapData', () => {
    it('returns inner data from envelope shape', () => {
      const payload = {
        ok: true,
        data: { id: '1', name: 'test' },
        meta: { timestamp: '2026-03-04T00:00:00Z', correlationId: 'abc' },
      };
      expect(unwrapData(payload)).toEqual({ id: '1', name: 'test' });
    });

    it('returns legacy payload as-is when no envelope', () => {
      const payload = { id: '1', name: 'test' };
      expect(unwrapData(payload)).toEqual({ id: '1', name: 'test' });
    });

    it('returns primitive payload as-is', () => {
      expect(unwrapData('hello')).toBe('hello');
      expect(unwrapData(42)).toBe(42);
      expect(unwrapData(null)).toBeNull();
    });

    it('returns arrays as-is (legacy)', () => {
      const payload = [{ id: '1' }, { id: '2' }];
      expect(unwrapData(payload)).toEqual(payload);
    });

    it('unwraps array data from envelope', () => {
      const payload = {
        ok: true,
        data: [{ id: '1' }],
        meta: { timestamp: '2026-03-04T00:00:00Z' },
      };
      expect(unwrapData(payload)).toEqual([{ id: '1' }]);
    });
  });

  // ── unwrapError ───────────────────────────────────────────────────────────────

  describe('unwrapError', () => {
    it('normalizes envelope error shape', () => {
      const payload = {
        ok: false,
        error: { statusCode: 401, message: 'Unauthorized' },
        meta: { timestamp: '2026-03-04T00:00:00Z', path: '/api/v1/me' },
      };
      const result = unwrapError(payload);
      expect(result.statusCode).toBe(401);
      expect(result.message).toBe('Unauthorized');
      expect(result.meta?.path).toBe('/api/v1/me');
    });

    it('normalizes legacy error shape', () => {
      const payload = {
        statusCode: 404,
        message: 'Not found',
        timestamp: '2026-03-04T00:00:00Z',
        path: '/api/v1/missing',
        correlationId: 'xyz',
      };
      const result = unwrapError(payload);
      expect(result.statusCode).toBe(404);
      expect(result.message).toBe('Not found');
      expect(result.meta?.correlationId).toBe('xyz');
    });

    it('returns 500 fallback for unknown shapes', () => {
      const result = unwrapError('something went wrong');
      expect(result.statusCode).toBe(500);
      expect(result.message).toBe('Unknown server error');
    });

    it('returns 500 fallback for null', () => {
      const result = unwrapError(null);
      expect(result.statusCode).toBe(500);
    });

    it('handles legacy error without timestamp', () => {
      const payload = { statusCode: 400, message: 'Bad request' };
      const result = unwrapError(payload);
      expect(result.statusCode).toBe(400);
      expect(result.message).toBe('Bad request');
      expect(result.meta).toBeUndefined();
    });
  });
});
