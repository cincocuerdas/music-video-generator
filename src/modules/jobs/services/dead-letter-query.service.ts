import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma';
import { DeadLetterEntry, DeadLetterService } from './dead-letter.service';

@Injectable()
export class DeadLetterQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly deadLetterService: DeadLetterService,
  ) {}

  async listForUser(userId: string, limit = 25): Promise<Record<string, unknown>> {
    const jobs = await this.deadLetterService.listJobs(limit);
    const projectIds = Array.from(
      new Set(
        jobs
          .map((queueJob) => {
            const payload =
              queueJob.data && typeof queueJob.data === 'object'
                ? (queueJob.data as Partial<DeadLetterEntry> & Record<string, unknown>)
                : null;
            return typeof payload?.projectId === 'string' ? payload.projectId : null;
          })
          .filter((value): value is string => typeof value === 'string'),
      ),
    );

    const ownedProjects = await this.prisma.project.findMany({
      where: { userId, id: { in: projectIds } },
      select: { id: true },
    });
    const ownedProjectIds = new Set(ownedProjects.map((project) => project.id));

    const ownedItems = jobs.filter((queueJob) => {
      const payload =
        queueJob.data && typeof queueJob.data === 'object'
          ? (queueJob.data as Partial<DeadLetterEntry>)
          : null;
      return Boolean(payload?.projectId && ownedProjectIds.has(payload.projectId));
    });

    const items = await Promise.all(
      ownedItems.map(async (queueJob) => ({
        deadLetterId: String(queueJob.id),
        status: await queueJob.getState(),
        name: queueJob.name,
        attemptsMade: queueJob.attemptsMade,
        failedReason: queueJob.failedReason || null,
        timestamp: queueJob.timestamp,
        data: queueJob.data,
      })),
    );

    return {
      total: items.length,
      items,
    };
  }
}
