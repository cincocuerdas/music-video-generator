import { UnauthorizedException } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';

const DEV_USER_ID = '00000000-0000-4000-8000-000000000001';

const buildExecutionContext = (request: Record<string, unknown>) =>
  ({
    switchToHttp: () => ({ getRequest: () => request }),
  }) as any;

describe('JwtAuthGuard', () => {
  const createGuard = () => {
    const authService = {
      authenticateRequest: jest.fn(),
    };
    const guard = new JwtAuthGuard(authService as any);
    return { guard, authService };
  };

  it('attaches user to request and returns true', () => {
    const { guard, authService } = createGuard();
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
    const { guard, authService } = createGuard();
    authService.authenticateRequest.mockImplementation(() => {
      throw new UnauthorizedException('Missing bearer token');
    });
    const ctx = buildExecutionContext({});

    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });
});
