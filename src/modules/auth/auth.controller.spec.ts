import { AuthController } from './auth.controller';

const DEV_USER_ID = '00000000-0000-4000-8000-000000000001';

const buildRequest = (overrides: Record<string, unknown> = {}) =>
  ({
    ip: '127.0.0.1',
    header: jest.fn((name: string) =>
      name.toLowerCase() === 'user-agent' ? 'jest-test' : undefined,
    ),
    ...overrides,
  }) as any;

const buildResponse = () =>
  ({
    cookie: jest.fn(),
    clearCookie: jest.fn(),
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

  it('createDevToken delegates to authService.issueDevToken', async () => {
    const { controller, authService } = createController();
    const dto = { userId: DEV_USER_ID, email: 'dev@test.com', name: 'Dev' };
    const expected = {
      token: 'tok',
      userId: DEV_USER_ID,
      tokenType: 'Bearer',
      expiresIn: '1h',
    };
    authService.issueDevToken.mockResolvedValue(expected);

    const result = await controller.createDevToken(dto);

    expect(result).toBe(expected);
    expect(authService.issueDevToken).toHaveBeenCalledWith(dto);
  });

  it('loginDev forwards dto and session context', async () => {
    const { controller, authService } = createController();
    const dto = { userId: DEV_USER_ID };
    authService.loginDev.mockResolvedValue({
      userId: DEV_USER_ID,
      accessToken: 'at',
      refreshToken: 'rt',
    });
    const req = buildRequest();
    const res = buildResponse();

    const result = await controller.loginDev(req, res, dto);

    expect(result).toEqual({ userId: DEV_USER_ID, accessToken: 'at' });
    expect(authService.loginDev).toHaveBeenCalledWith(dto, {
      ipAddress: '127.0.0.1',
      userAgent: 'jest-test',
    });
    expect(res.cookie).toHaveBeenCalledWith(
      'mvg_refresh_token',
      'rt',
      expect.objectContaining({ httpOnly: true, sameSite: 'lax', path: '/api/v1/auth' }),
    );
  });

  it('loginDev passes undefined userAgent when header is absent', async () => {
    const { controller, authService } = createController();
    const req = buildRequest({
      header: jest.fn(() => undefined),
    });
    const res = buildResponse();
    authService.loginDev.mockResolvedValue({ accessToken: 'at', refreshToken: 'rt' });

    await controller.loginDev(req, res, {});

    expect(authService.loginDev).toHaveBeenCalledWith({}, {
      ipAddress: '127.0.0.1',
      userAgent: undefined,
    });
  });

  it('refresh delegates refreshToken and session context', async () => {
    const { controller, authService } = createController();
    const dto = { refreshToken: 'refresh-token-value' };
    authService.refreshSession.mockResolvedValue({
      accessToken: 'new-at',
      refreshToken: 'new-rt',
    });
    const req = buildRequest();
    const res = buildResponse();

    const result = await controller.refresh(req, res, dto);

    expect(result).toEqual({ accessToken: 'new-at' });
    expect(authService.refreshSession).toHaveBeenCalledWith('refresh-token-value', {
      ipAddress: '127.0.0.1',
      userAgent: 'jest-test',
    });
    expect(res.cookie).toHaveBeenCalledWith(
      'mvg_refresh_token',
      'new-rt',
      expect.objectContaining({ httpOnly: true, sameSite: 'lax', path: '/api/v1/auth' }),
    );
  });

  it('refresh falls back to cookie token when body token is absent', async () => {
    const { controller, authService } = createController();
    authService.refreshSession.mockResolvedValue({
      accessToken: 'new-at',
      refreshToken: 'new-rt',
    });
    const req = buildRequest({
      header: jest.fn((name: string) => {
        const normalized = name.toLowerCase();
        if (normalized === 'user-agent') return 'jest-test';
        if (normalized === 'cookie') return 'mvg_refresh_token=cookie-refresh-token';
        return undefined;
      }),
    });
    const res = buildResponse();

    await controller.refresh(req, res, {});

    expect(authService.refreshSession).toHaveBeenCalledWith('cookie-refresh-token', {
      ipAddress: '127.0.0.1',
      userAgent: 'jest-test',
    });
  });

  it('logout delegates refreshToken from dto', async () => {
    const { controller, authService } = createController();
    const dto = { refreshToken: 'rt-to-revoke' };
    authService.logout.mockResolvedValue({ success: true });
    const req = buildRequest();
    const res = buildResponse();

    const result = await controller.logout(req, res, dto);

    expect(result).toEqual({ success: true });
    expect(authService.logout).toHaveBeenCalledWith('rt-to-revoke');
    expect(res.clearCookie).toHaveBeenCalledWith(
      'mvg_refresh_token',
      expect.objectContaining({ httpOnly: true, sameSite: 'lax', path: '/api/v1/auth' }),
    );
  });

  it('logout falls back to cookie token when refreshToken is absent', async () => {
    const { controller, authService } = createController();
    authService.logout.mockResolvedValue({ success: true });
    const req = buildRequest({
      header: jest.fn((name: string) => {
        const normalized = name.toLowerCase();
        if (normalized === 'user-agent') return 'jest-test';
        if (normalized === 'cookie') return 'mvg_refresh_token=cookie-refresh-token';
        return undefined;
      }),
    });
    const res = buildResponse();

    const result = await controller.logout(req, res, {} as any);

    expect(result).toEqual({ success: true });
    expect(authService.logout).toHaveBeenCalledWith('cookie-refresh-token');
  });

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
