import { SetMetadata } from '@nestjs/common';
import { QuotaResource } from '../services/user-quota.service';
import { QUOTA_RESOURCE_KEY } from '../guards/user-quota.guard';

export const RequireQuota = (resource: QuotaResource) =>
  SetMetadata(QUOTA_RESOURCE_KEY, resource);
