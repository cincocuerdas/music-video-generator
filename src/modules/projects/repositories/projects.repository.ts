import { Injectable, NotFoundException } from '@nestjs/common';
import { Project, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma';

@Injectable()
export class ProjectsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: Prisma.ProjectUncheckedCreateInput): Promise<Project> {
    return this.prisma.project.create({ data });
  }

  async findMany(userId: string, skip: number, take: number) {
    return this.prisma.project.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    });
  }

  async count(userId: string): Promise<number> {
    return this.prisma.project.count({ where: { userId } });
  }

  async findOneWithJobs(id: string, userId: string) {
    return this.prisma.project.findFirst({
      where: { id, userId },
      include: { jobs: { orderBy: { createdAt: 'asc' } } },
    });
  }

  async findOne(id: string, userId: string) {
    return this.prisma.project.findFirst({
      where: { id, userId },
    });
  }

  async findFirst(id: string, userId: string) {
    return this.prisma.project.findFirst({
      where: { id, userId },
      select: { id: true },
    });
  }

  async update(id: string, data: Prisma.ProjectUpdateInput): Promise<Project> {
    return this.prisma.project.update({ where: { id }, data });
  }

  async delete(id: string): Promise<Project> {
    return this.prisma.project.delete({ where: { id } });
  }

  async findForStatus(id: string, userId: string) {
    return this.prisma.project.findFirst({
      where: { id, userId },
      include: {
        jobs: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            type: true,
            status: true,
            progress: true,
            currentStep: true,
            errorMessage: true,
            outputData: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
    });
  }

  async findForVideo(id: string, userId: string) {
    return this.prisma.project.findFirst({
      where: { id, userId },
      select: {
        id: true,
        status: true,
        videoUrl: true,
        thumbnailUrl: true,
        jobs: {
          select: {
            type: true,
            status: true,
            outputData: true,
          },
        },
      },
    });
  }

  async findForDownload(id: string, userId: string) {
    return this.prisma.project.findFirst({
      where: { id, userId },
      select: { id: true, videoUrl: true },
    });
  }
}
