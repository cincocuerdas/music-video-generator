import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Req,
  Query,
  UseGuards,
  ParseUUIDPipe,
  DefaultValuePipe,
  ParseIntPipe,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { THROTTLE_RULES } from '../../common/constants';
import { JobsService } from './jobs.service';
import { CreateJobDto, UpdateJobDto } from './dto';
import {
  AuthenticatedRequest,
  AuthService,
  JwtAuthGuard,
} from '../auth';

@Controller('jobs')
@UseGuards(JwtAuthGuard)
export class JobsController {
  constructor(
    private readonly jobsService: JobsService,
    private readonly authService: AuthService,
  ) {}

  @Post()
  @Throttle(THROTTLE_RULES.jobsCreate)
  create(
    @Req() req: AuthenticatedRequest,
    @Body() createJobDto: CreateJobDto,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.jobsService.createForUser(userId, createJobDto);
  }

  @Get('dead-letter')
  @Throttle(THROTTLE_RULES.jobsCreate)
  listDeadLetter(
    @Req() req: AuthenticatedRequest,
    @Query('limit', new DefaultValuePipe(25), ParseIntPipe) limit: number,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.jobsService.listDeadLettersForUser(userId, limit);
  }

  @Post('dead-letter/:id/replay')
  @Throttle(THROTTLE_RULES.jobsPipelineStart)
  replayDeadLetter(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.jobsService.replayDeadLetterForUser(id, userId);
  }

  @Get(':id')
  findOne(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.jobsService.findOneForUser(id, userId);
  }

  @Patch(':id')
  @Throttle(THROTTLE_RULES.jobsUpdate)
  update(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateJobDto: UpdateJobDto,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.jobsService.updateForUser(id, userId, updateJobDto);
  }

  @Delete(':id')
  @Throttle(THROTTLE_RULES.jobsDelete)
  remove(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.jobsService.removeForUser(id, userId);
  }

  @Post('pipeline/:id/start')
  @Throttle(THROTTLE_RULES.jobsPipelineStart)
  startPipeline(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.jobsService.startPipelineForUser(id, userId);
  }

  @Get('pipeline/:id')
  getPipelineStatus(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.jobsService.getPipelineStatusForUser(id, userId);
  }

  @Post('pipeline/:id/cancel')
  @Throttle(THROTTLE_RULES.jobsPipelineCancel)
  cancelPipeline(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.jobsService.cancelPipelineForUser(id, userId);
  }
}
