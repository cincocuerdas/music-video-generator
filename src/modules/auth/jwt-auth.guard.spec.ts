import { UnauthorizedException } from '@nestjs/common';
import { IS_PUBLIC_KEY } from './public.decorator';
import { JwtAuthGuard } from './jwt-auth.guard';

const DEV_USER_ID = '00000000-0000-4000-8000-000000000001';

const buildExecutionContext = (request: Record<string, unknown>) =>
  ({
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => 'handler',
    getClass: () => 'class',
  }) as any;

describe('JwtAuthGuard', () => {
  const createGuard = () => {
    const authService = {
      authenticateRequest: jest.fn(),
    };
    const reflector = {
      getAllAndOverride: jest.fn(),
    };
    const guard = new JwtAuthGuard(authService as any, reflector as any);
    return { guard, authService, reflector };
  };

  it('bypasses authentication for public routes', () => {
    const { guard, authService, reflector } = createGuard();
    reflector.getAllAndOverride.mockImplementation(
      (key: string) => (key === IS_PUBLIC_KEY ? true : undefined),
    );
    const request: Record<string, unknown> = {};
    const ctx = buildExecutionContext(request);

    const result = guard.canActivate(ctx);

    expect(result).toBe(true);
    expect(request.user).toBeUndefined();
    expect(authService.authenticateRequest).not.toHaveBeenCalled();
  });

  it('attaches user to request and returns true', () => {
    const { guard, authService, reflector } = createGuard();
    reflector.getAllAndOverride.mockReturnValue(false);
    const user = { userId: DEV_USER_ID, token: 'tok', claims: {} };
    authService.authenticateRequest.mockReturnValue(user);
    const request: Record<string, unknown> = {};
    const ctx = buildExecutionContext(request);

    const result = guard.canActivate(ctx);

    expect(result).toBe(true);
    expect(request.user).toBe(user);
    expect(authService.authenticateRequest).toHaveBeenCalledWith(request);
  });

  it('propagates UnauthorizedException from AuthService', () => {
    const { guard, authService, reflector } = createGuard();
    reflector.getAllAndOverride.mockReturnValue(false);
    authService.authenticateRequest.mockImplementation(() => {
      throw new UnauthorizedException('Missing bearer token');
    });
    const ctx = buildExecutionContext({});

    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });
});
