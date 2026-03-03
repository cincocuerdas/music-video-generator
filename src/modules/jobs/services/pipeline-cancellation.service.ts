import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { JobStatus, ProjectStatus } from '@prisma/client';
import { PrismaService } from '../../prisma';

@Injectable()
export class PipelineCancellationService {
  private readonly logger = new Logger(PipelineCancellationService.name);

  constructor(private readonly prisma: PrismaService) {}

  async cancelPipeline(projectId: string): Promise<void> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });

    if (!project) {
      throw new NotFoundException(`Project with id ${projectId} not found`);
    }

    await this.prisma.$transaction([
      this.prisma.job.updateMany({
        where: {
          projectId,
          status: { in: [JobStatus.PENDING, JobStatus.PROCESSING] },
        },
        data: { status: JobStatus.CANCELLED },
      }),
      this.prisma.project.update({
        where: { id: projectId },
        data: { status: ProjectStatus.CANCELLED },
      }),
    ]);

    this.logger.log(`Pipeline cancelled for project ${projectId}`);
  }
}

