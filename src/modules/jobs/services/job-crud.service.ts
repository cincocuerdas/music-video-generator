import { Injectable, NotFoundException } from '@nestjs/common';
import { Job } from '@prisma/client';
import { PrismaService } from '../../prisma';
import { CreateJobDto, UpdateJobDto } from '../types/jobs-crud.type';

@Injectable()
export class JobCrudService {
  constructor(private readonly prisma: PrismaService) {}

  async assertProjectOwnership(projectId: string, userId: string): Promise<void> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, userId },
      select: { id: true },
    });

    if (!project) {
      throw new NotFoundException(`Project with id ${projectId} not found`);
    }
  }

  async create(data: CreateJobDto): Promise<Job> {
    return this.prisma.job.create({
      data: {
        projectId: data.projectId,
        type: data.type,
        inputData: data.inputData ?? undefined,
      },
    });
  }

  async findOne(id: string): Promise<Job> {
    const job = await this.prisma.job.findUnique({
      where: { id },
    });
    if (!job) throw new NotFoundException(`Job with id ${id} not found`);
    return job;
  }

  async findByProject(projectId: string): Promise<Job[]> {
    return this.prisma.job.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async remove(id: string): Promise<Job> {
    const job = await this.prisma.job.findUnique({
      where: { id },
    });
    if (!job) throw new NotFoundException(`Job with id ${id} not found`);
    return this.prisma.job.delete({
      where: { id },
    });
  }

  async findOneForUser(id: string, userId: string): Promise<Job> {
    const job = await this.prisma.job.findFirst({
      where: { id, project: { userId } },
    });
    if (!job) throw new NotFoundException(`Job with id ${id} not found`);
    return job;
  }

  async updateForUser(id: string, userId: string, data: UpdateJobDto): Promise<Job> {
    const job = await this.findOneForUser(id, userId);
    return this.prisma.job.update({
      where: { id: job.id },
      data,
    });
  }

  async removeForUser(id: string, userId: string): Promise<Job> {
    const job = await this.findOneForUser(id, userId);
    return this.prisma.job.delete({
      where: { id: job.id },
    });
  }
}
