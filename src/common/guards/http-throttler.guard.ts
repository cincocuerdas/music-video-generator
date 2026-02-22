import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AuthenticatedRequest } from '../../modules/auth';

@Injectable()
export class HttpThrottlerGuard extends ThrottlerGuard {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType<'http' | 'ws' | 'rpc'>() !== 'http') {
      return true;
    }
    return super.canActivate(context);
  }

  protected async getTracker(req: Record<string, any>): Promise<string> {
    const request = req as AuthenticatedRequest;
    const userId =
      typeof request.user?.userId === 'string' && request.user.userId.trim()
        ? request.user.userId.trim()
        : null;

    if (userId) {
      return `user:${userId}`;
    }

    const forwarded = request.headers?.['x-forwarded-for'];
    const forwardedValue = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const forwardedIp =
      typeof forwardedValue === 'string' ? forwardedValue.split(',')[0]?.trim() : undefined;

    const ip =
      request.ip ||
      request.ips?.[0] ||
      forwardedIp ||
      request.socket?.remoteAddress ||
      'anonymous';

    return `ip:${ip}`;
  }
}
