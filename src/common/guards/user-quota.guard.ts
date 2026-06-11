import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserQuotaService, QuotaResource } from '../services/user-quota.service';
import { AuthenticatedRequest } from '../../modules/auth';

export const QUOTA_RESOURCE_KEY = 'quota_resource';

@Injectable()
export class UserQuotaGuard implements CanActivate {
  private readonly logger = new Logger(UserQuotaGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly quotaService: UserQuotaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const resource = this.reflector.getAllAndOverride<QuotaResource | undefined>(
      QUOTA_RESOURCE_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!resource) {
      return true;
    }

    if (context.getType<'http'>() !== 'http') {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const userId = request.user?.userId;

    if (!userId) {
      return true;
    }

    const result = await this.quotaService.checkQuota(userId, resource);

    if (!result.allowed) {
      this.logger.warn(
        `Quota exceeded: user=${userId} resource=${resource} current=${result.current} limit=${result.limit}`,
      );
      throw new ForbiddenException(
        `Daily ${resource} quota exceeded (${result.current}/${result.limit}). Resets at ${result.resetsAt}.`,
      );
    }

    return true;
  }
}
