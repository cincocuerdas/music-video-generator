import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { sign } from 'jsonwebtoken';
import { createHash } from 'crypto';
import type { Request } from 'express';
import { AuthService } from './auth.service';

const DEV_USER_ID = '00000000-0000-4000-8000-000000000001';
const ALT_USER_ID = '00000000-0000-4000-8000-000000000111';

const buildRequest = (authorization?: string): Request =>
  ({
    header: jest.fn((name: string) => {
      if (name.toLowerCase() === 'authorization') {
        return authorization;
      }
      return undefined;
    }),
  }) as unknown as Request;

const buildSocket = (auth: Record<string, unknown> = {}, authorizationHeader?: string) =>
  ({
    handshake: {
      auth,
      headers: {
        authorization: authorizationHeader,
      },
    },
  }) as any;

const hashTokenWithPepper = (token: string, pepper: string) =>
  createHash('sha256').update(token).update(pepper).digest('hex');

describe('AuthService', () => {
  const envSnapshot = { ...process.env };

  const createService = () => {
    const prisma = {
      user: {
        upsert: jest.fn().mockResolvedValue(undefined),
      },
      authSession: {
        create: jest.fn().mockResolvedValue(undefined),
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue(undefined),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };

    const service = new AuthService(prisma as any);
    return { service, prisma };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...envSnapshot };
    process.env.NODE_ENV = 'development';
    process.env.JWT_SECRET = 'test_jwt_secret_123456789012345678901234567890';
    process.env.JWT_REFRESH_SECRET = 'test_refresh_secret_123456789012345678901234567890';
    process.env.JWT_REFRESH_TOKEN_PEPPER = 'test_pepper_123456789012345678901234567890';
    process.env.JWT_EXPIRES_IN = '1h';
    process.env.JWT_REFRESH_EXPIRES_IN = '30d';
    delete process.env.ALLOW_DEV_AUTH_BYPASS;
    delete process.env.DEV_USER_ID;
    delete process.env.JWT_USER_ID_CLAIM;
  });

  afterAll(() => {
    process.env = envSnapshot;
  });

  it('blocks dev auth endpoint in production', async () => {
    const { service } = createService();
    process.env.NODE_ENV = 'production';

    await expect(
      service.issueDevToken({
        userId: DEV_USER_ID,
        email: 'dev@example.com',
        name: 'Dev User',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('issues dev token and upserts user in development', async () => {
    const { service, prisma } = createService();

    const result = await service.issueDevToken({
      userId: ALT_USER_ID,
      email: 'dev2@example.com',
      name: 'Dev User 2',
    });

    expect(result.userId).toBe(ALT_USER_ID);
    expect(result.tokenType).toBe('Bearer');
    expect(typeof result.token).toBe('string');
    expect(prisma.user.upsert).toHaveBeenCalledTimes(1);
  });

  it('authenticates via dev bypass when enabled and no bearer token', () => {
    const { service } = createService();
    process.env.ALLOW_DEV_AUTH_BYPASS = 'true';
    process.env.DEV_USER_ID = DEV_USER_ID;
    const req = buildRequest(undefined);

    const user = service.authenticateRequest(req);

    expect(user.userId).toBe(DEV_USER_ID);
    expect(user.token).toBe('__dev_bypass__');
    expect(user.claims.source).toBe('dev-bypass');
  });

  it('rejects missing bearer token when bypass is disabled', () => {
    const { service } = createService();
    const req = buildRequest(undefined);

    expect(() => service.authenticateRequest(req)).toThrow(UnauthorizedException);
  });

  it('rejects token signed with a different secret', () => {
    const { service } = createService();
    const token = sign(
      { sub: DEV_USER_ID, role: 'user' },
      'wrong_secret_for_test_only',
      { algorithm: 'HS256', expiresIn: '1h' },
    );
    const req = buildRequest(`Bearer ${token}`);

    expect(() => service.authenticateRequest(req)).toThrow(UnauthorizedException);
  });

  it('rejects expired access token', () => {
    const { service } = createService();
    const token = sign(
      { sub: DEV_USER_ID, role: 'user' },
      process.env.JWT_SECRET as string,
      { algorithm: 'HS256', expiresIn: '-10s' },
    );
    const req = buildRequest(`Bearer ${token}`);

    expect(() => service.authenticateRequest(req)).toThrow(UnauthorizedException);
  });

  it('accepts access token using configured user claim', () => {
    const { service } = createService();
    process.env.JWT_USER_ID_CLAIM = 'uid';

    const token = sign(
      { sub: 'not-used', uid: ALT_USER_ID, role: 'user' },
      process.env.JWT_SECRET as string,
      { algorithm: 'HS256', expiresIn: '1h' },
    );

    const req = buildRequest(`Bearer ${token}`);
    const user = service.authenticateRequest(req);

    expect(user.userId).toBe(ALT_USER_ID);
  });

  it('revokes refresh session when token hash mismatches', async () => {
    const { service, prisma } = createService();
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const refreshToken = sign(
      { sub: DEV_USER_ID, sid: sessionId, type: 'refresh' },
      process.env.JWT_REFRESH_SECRET as string,
      { algorithm: 'HS256', expiresIn: '1h' },
    );

    prisma.authSession.findUnique.mockResolvedValue({
      id: sessionId,
      userId: DEV_USER_ID,
      tokenHash: 'different-hash',
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(
      service.refreshSession(refreshToken, {
        ipAddress: '127.0.0.1',
        userAgent: 'jest',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(prisma.authSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: sessionId },
        data: expect.objectContaining({
          revokedAt: expect.any(Date),
        }),
      }),
    );
  });

  it('rotates refresh session on valid refresh token', async () => {
    const { service, prisma } = createService();
    const sessionId = '22222222-2222-4222-8222-222222222222';
    const refreshToken = sign(
      { sub: DEV_USER_ID, sid: sessionId, type: 'refresh' },
      process.env.JWT_REFRESH_SECRET as string,
      { algorithm: 'HS256', expiresIn: '1h' },
    );
    const refreshTokenHash = hashTokenWithPepper(
      refreshToken,
      process.env.JWT_REFRESH_TOKEN_PEPPER as string,
    );

    prisma.authSession.findUnique.mockResolvedValue({
      id: sessionId,
      userId: DEV_USER_ID,
      tokenHash: refreshTokenHash,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const result = await service.refreshSession(refreshToken, {
      ipAddress: '127.0.0.1',
      userAgent: 'jest',
    });

    expect(result.userId).toBe(DEV_USER_ID);
    expect(typeof result.accessToken).toBe('string');
    expect(typeof result.refreshToken).toBe('string');
    expect(prisma.authSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: sessionId },
        data: expect.objectContaining({
          tokenHash: expect.any(String),
          revokedAt: null,
          ipAddress: '127.0.0.1',
          userAgent: 'jest',
        }),
      }),
    );
  });

  it('rejects refresh token payload without session id', async () => {
    const { service } = createService();
    const invalidRefreshToken = sign(
      { sub: DEV_USER_ID, type: 'refresh' },
      process.env.JWT_REFRESH_SECRET as string,
      { algorithm: 'HS256', expiresIn: '1h' },
    );

    await expect(
      service.refreshSession(invalidRefreshToken, {
        ipAddress: '127.0.0.1',
        userAgent: 'jest',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects refresh when session is already revoked', async () => {
    const { service, prisma } = createService();
    const sessionId = '33333333-3333-4333-8333-333333333333';
    const refreshToken = sign(
      { sub: DEV_USER_ID, sid: sessionId, type: 'refresh' },
      process.env.JWT_REFRESH_SECRET as string,
      { algorithm: 'HS256', expiresIn: '1h' },
    );

    prisma.authSession.findUnique.mockResolvedValue({
      id: sessionId,
      userId: DEV_USER_ID,
      tokenHash: 'any-hash',
      revokedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(
      service.refreshSession(refreshToken, {
        ipAddress: '127.0.0.1',
        userAgent: 'jest',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects refresh when session is expired', async () => {
    const { service, prisma } = createService();
    const sessionId = '44444444-4444-4444-8444-444444444444';
    const refreshToken = sign(
      { sub: DEV_USER_ID, sid: sessionId, type: 'refresh' },
      process.env.JWT_REFRESH_SECRET as string,
      { algorithm: 'HS256', expiresIn: '1h' },
    );
    const refreshTokenHash = hashTokenWithPepper(
      refreshToken,
      process.env.JWT_REFRESH_TOKEN_PEPPER as string,
    );

    prisma.authSession.findUnique.mockResolvedValue({
      id: sessionId,
      userId: DEV_USER_ID,
      tokenHash: refreshTokenHash,
      revokedAt: null,
      expiresAt: new Date(Date.now() - 60_000),
    });

    await expect(
      service.refreshSession(refreshToken, {
        ipAddress: '127.0.0.1',
        userAgent: 'jest',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('authenticates socket token from handshake auth.token', () => {
    const { service } = createService();
    const token = sign(
      { sub: DEV_USER_ID, role: 'user' },
      process.env.JWT_SECRET as string,
      { algorithm: 'HS256', expiresIn: '1h' },
    );
    const client = buildSocket({ token });

    const user = service.authenticateSocket(client);

    expect(user.userId).toBe(DEV_USER_ID);
    expect(user.token).toBe(token);
  });

  it('authenticates socket token from Bearer authorization header', () => {
    const { service } = createService();
    const token = sign(
      { sub: ALT_USER_ID, role: 'user' },
      process.env.JWT_SECRET as string,
      { algorithm: 'HS256', expiresIn: '1h' },
    );
    const client = buildSocket({}, `Bearer ${token}`);

    const user = service.authenticateSocket(client);

    expect(user.userId).toBe(ALT_USER_ID);
    expect(user.token).toBe(token);
  });

  // ── logout ────────────────────────────────────────────────────────

  it('logout revokes session for valid refresh token', async () => {
    const { service, prisma } = createService();
    const sessionId = '55555555-5555-4555-8555-555555555555';
    const refreshToken = sign(
      { sub: DEV_USER_ID, sid: sessionId, type: 'refresh' },
      process.env.JWT_REFRESH_SECRET as string,
      { algorithm: 'HS256', expiresIn: '1h' },
    );

    const result = await service.logout(refreshToken);

    expect(result).toEqual({ success: true });
    expect(prisma.authSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: sessionId, userId: DEV_USER_ID, revokedAt: null },
        data: expect.objectContaining({ revokedAt: expect.any(Date) }),
      }),
    );
  });

  it('logout without token returns success without touching sessions', async () => {
    const { service, prisma } = createService();

    const result = await service.logout(undefined);

    expect(result).toEqual({ success: true });
    expect(prisma.authSession.updateMany).not.toHaveBeenCalled();
  });

  it('logout with expired refresh token returns success (idempotent)', async () => {
    const { service, prisma } = createService();
    const expiredToken = sign(
      { sub: DEV_USER_ID, sid: '66666666-6666-4666-8666-666666666666', type: 'refresh' },
      process.env.JWT_REFRESH_SECRET as string,
      { algorithm: 'HS256', expiresIn: '-10s' },
    );

    const result = await service.logout(expiredToken);

    expect(result).toEqual({ success: true });
    expect(prisma.authSession.updateMany).not.toHaveBeenCalled();
  });

  // ── getUserIdFromRequest ──────────────────────────────────────────

  it('getUserIdFromRequest returns userId when user is present', () => {
    const { service } = createService();
    const req = { user: { userId: DEV_USER_ID, token: 'tok', claims: {} } } as any;

    expect(service.getUserIdFromRequest(req)).toBe(DEV_USER_ID);
  });

  it('getUserIdFromRequest throws when user is absent', () => {
    const { service } = createService();
    const req = {} as any;

    expect(() => service.getUserIdFromRequest(req)).toThrow(UnauthorizedException);
  });

  // ── authenticateRequest negative paths ────────────────────────────

  it('rejects token with non-UUID sub claim', () => {
    const { service } = createService();
    const token = sign(
      { sub: 'not-a-uuid', role: 'user' },
      process.env.JWT_SECRET as string,
      { algorithm: 'HS256', expiresIn: '1h' },
    );
    const req = buildRequest(`Bearer ${token}`);

    expect(() => service.authenticateRequest(req)).toThrow(UnauthorizedException);
  });

  it('rejects token without any user id claim', () => {
    const { service } = createService();
    const token = sign(
      { role: 'user' },
      process.env.JWT_SECRET as string,
      { algorithm: 'HS256', expiresIn: '1h' },
    );
    const req = buildRequest(`Bearer ${token}`);

    expect(() => service.authenticateRequest(req)).toThrow(UnauthorizedException);
  });

  it('rejects malformed bearer header (no token after prefix)', () => {
    const { service } = createService();
    const req = buildRequest('Bearer ');

    expect(() => service.authenticateRequest(req)).toThrow(UnauthorizedException);
  });

  // ── authenticateSocket negative path ──────────────────────────────

  it('rejects socket when no token and bypass disabled', () => {
    const { service } = createService();
    const client = buildSocket({});

    expect(() => service.authenticateSocket(client)).toThrow(UnauthorizedException);
  });

  // ── refreshSession negative paths ─────────────────────────────────

  it('rejects refresh when session not found', async () => {
    const { service, prisma } = createService();
    const sessionId = '77777777-7777-4777-8777-777777777777';
    const refreshToken = sign(
      { sub: DEV_USER_ID, sid: sessionId, type: 'refresh' },
      process.env.JWT_REFRESH_SECRET as string,
      { algorithm: 'HS256', expiresIn: '1h' },
    );
    prisma.authSession.findUnique.mockResolvedValue(null);

    await expect(
      service.refreshSession(refreshToken, { ipAddress: '127.0.0.1', userAgent: 'jest' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects refresh when session belongs to different user', async () => {
    const { service, prisma } = createService();
    const sessionId = '88888888-8888-4888-8888-888888888888';
    const refreshToken = sign(
      { sub: DEV_USER_ID, sid: sessionId, type: 'refresh' },
      process.env.JWT_REFRESH_SECRET as string,
      { algorithm: 'HS256', expiresIn: '1h' },
    );
    prisma.authSession.findUnique.mockResolvedValue({
      id: sessionId,
      userId: ALT_USER_ID,
      tokenHash: 'irrelevant',
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(
      service.refreshSession(refreshToken, { ipAddress: '127.0.0.1', userAgent: 'jest' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects refresh token signed with wrong secret', async () => {
    const { service } = createService();
    const refreshToken = sign(
      { sub: DEV_USER_ID, sid: '99999999-9999-4999-8999-999999999999', type: 'refresh' },
      'wrong_refresh_secret_1234567890',
      { algorithm: 'HS256', expiresIn: '1h' },
    );

    await expect(
      service.refreshSession(refreshToken, { ipAddress: '127.0.0.1', userAgent: 'jest' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  // ── loginDev negative paths ───────────────────────────────────────

  it('loginDev blocks in production', async () => {
    const { service } = createService();
    process.env.NODE_ENV = 'production';

    await expect(
      service.loginDev(
        { userId: DEV_USER_ID, email: 'dev@test.com', name: 'Dev' },
        { ipAddress: '127.0.0.1' },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('loginDev rejects non-UUID userId', async () => {
    const { service } = createService();

    await expect(
      service.loginDev(
        { userId: 'not-a-uuid', email: 'dev@test.com' },
        { ipAddress: '127.0.0.1' },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  // ── dev bypass edge case ──────────────────────────────────────────

  it('rejects dev bypass when DEV_USER_ID is invalid non-UUID', () => {
    const { service } = createService();
    process.env.ALLOW_DEV_AUTH_BYPASS = 'true';
    process.env.DEV_USER_ID = 'bad-value';
    const req = buildRequest(undefined);

    expect(() => service.authenticateRequest(req)).toThrow(UnauthorizedException);
  });
});
