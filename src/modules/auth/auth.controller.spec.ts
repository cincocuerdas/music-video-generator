import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

const DEV_USER_ID = '00000000-0000-4000-8000-000000000001';

const buildRequest = (overrides: Record<string, unknown> = {}) =>
  ({
    ip: '127.0.0.1',
    header: jest.fn((name: string) =>
      name.toLowerCase() === 'user-agent' ? 'jest-test' : undefined,
    ),
    ...overrides,
  }) as any;

describe('AuthController', () => {
  const createController = () => {
    const authService = {
      issueDevToken: jest.fn(),
      loginDev: jest.fn(),
      refreshSession: jest.fn(),
      logout: jest.fn(),
      getUserIdFromRequest: jest.fn(),
    };
    const controller = new AuthController(authService as any);
    return { controller, authService };
  };

  // ── POST /auth/dev-token ──────────────────────────────────────────

  it('createDevToken delegates to authService.issueDevToken', async () => {
    const { controller, authService } = createController();
    const dto = { userId: DEV_USER_ID, email: 'dev@test.com', name: 'Dev' };
    const expected = { token: 'tok', userId: DEV_USER_ID, tokenType: 'Bearer', expiresIn: '1h' };
    authService.issueDevToken.mockResolvedValue(expected);

    const result = await controller.createDevToken(dto);

    expect(result).toBe(expected);
    expect(authService.issueDevToken).toHaveBeenCalledWith(dto);
  });

  // ── POST /auth/login/dev ──────────────────────────────────────────

  it('loginDev forwards dto and session context', async () => {
    const { controller, authService } = createController();
    const dto = { userId: DEV_USER_ID };
    const expected = { userId: DEV_USER_ID, accessToken: 'at', refreshToken: 'rt' };
    authService.loginDev.mockResolvedValue(expected);
    const req = buildRequest();

    const result = await controller.loginDev(req, dto);

    expect(result).toBe(expected);
    expect(authService.loginDev).toHaveBeenCalledWith(dto, {
      ipAddress: '127.0.0.1',
      userAgent: 'jest-test',
    });
  });

  it('loginDev passes undefined userAgent when header is absent', async () => {
    const { controller, authService } = createController();
    const req = buildRequest({
      header: jest.fn(() => undefined),
    });
    authService.loginDev.mockResolvedValue({});

    await controller.loginDev(req, {});

    expect(authService.loginDev).toHaveBeenCalledWith({}, {
      ipAddress: '127.0.0.1',
      userAgent: undefined,
    });
  });

  // ── POST /auth/refresh ────────────────────────────────────────────

  it('refresh delegates refreshToken and session context', async () => {
    const { controller, authService } = createController();
    const dto = { refreshToken: 'refresh-token-value' };
    const expected = { accessToken: 'new-at', refreshToken: 'new-rt' };
    authService.refreshSession.mockResolvedValue(expected);
    const req = buildRequest();

    const result = await controller.refresh(req, dto);

    expect(result).toBe(expected);
    expect(authService.refreshSession).toHaveBeenCalledWith('refresh-token-value', {
      ipAddress: '127.0.0.1',
      userAgent: 'jest-test',
    });
  });

  // ── POST /auth/logout ─────────────────────────────────────────────

  it('logout delegates refreshToken from dto', async () => {
    const { controller, authService } = createController();
    const dto = { refreshToken: 'rt-to-revoke' };
    authService.logout.mockResolvedValue({ success: true });

    const result = await controller.logout(dto);

    expect(result).toEqual({ success: true });
    expect(authService.logout).toHaveBeenCalledWith('rt-to-revoke');
  });

  it('logout delegates undefined when refreshToken is absent', async () => {
    const { controller, authService } = createController();
    authService.logout.mockResolvedValue({ success: true });

    const result = await controller.logout({} as any);

    expect(result).toEqual({ success: true });
    expect(authService.logout).toHaveBeenCalledWith(undefined);
  });

  // ── GET /auth/me ──────────────────────────────────────────────────

  it('getMe returns userId and claims from authenticated request', () => {
    const { controller, authService } = createController();
    authService.getUserIdFromRequest.mockReturnValue(DEV_USER_ID);
    const req = buildRequest({
      user: { userId: DEV_USER_ID, token: 'tok', claims: { sub: DEV_USER_ID, role: 'user' } },
    });

    const result = controller.getMe(req);

    expect(result).toEqual({
      userId: DEV_USER_ID,
      claims: { sub: DEV_USER_ID, role: 'user' },
    });
    expect(authService.getUserIdFromRequest).toHaveBeenCalledWith(req);
  });

  it('getMe returns empty claims when req.user is absent', () => {
    const { controller, authService } = createController();
    authService.getUserIdFromRequest.mockReturnValue(DEV_USER_ID);
    const req = buildRequest();

    const result = controller.getMe(req);

    expect(result).toEqual({ userId: DEV_USER_ID, claims: {} });
  });
});
