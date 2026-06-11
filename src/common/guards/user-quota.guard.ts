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

    if (!resource) return true;
    if (context.getType<'http'>() !== 'http') return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const userId = request.user?.userId;
    if (!userId) return true;

    const result = await this.quotaService.checkAndIncrement(userId, resource);

    if (!result.ok) {
      this.logger.warn(`Quota denied: user=${userId} resource=${resource} reason=${result.reason}`);
      throw new ForbiddenException(result.reason);
    }

    return true;
  }
}
