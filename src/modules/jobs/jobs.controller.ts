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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JobsService } from './jobs.service';
import { DeadLetterOrchestratorService } from './services/dead-letter-orchestrator.service';
import { CreateJobDto, UpdateJobDto } from './dto';
import {
  AuthenticatedRequest,
  AuthService,
  JwtAuthGuard,
} from '../auth';

@Controller('jobs')
@UseGuards(JwtAuthGuard)
@ApiTags('jobs')
@ApiBearerAuth()
export class JobsController {
  constructor(
    private readonly jobsService: JobsService,
    private readonly deadLetterOrchestrator: DeadLetterOrchestratorService,
    private readonly authService: AuthService,
  ) {}

  @Post()
  @Throttle(THROTTLE_RULES.jobsCreate)
  @ApiOperation({ summary: 'Create a standalone job for a project' })
  create(
    @Req() req: AuthenticatedRequest,
    @Body() createJobDto: CreateJobDto,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.jobsService.createForUser(userId, createJobDto);
  }

  @Get('dead-letter')
  @Throttle(THROTTLE_RULES.jobsCreate)
  @ApiOperation({ summary: 'List dead-letter jobs for current user' })
  listDeadLetter(
    @Req() req: AuthenticatedRequest,
    @Query('limit', new DefaultValuePipe(25), ParseIntPipe) limit: number,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.deadLetterOrchestrator.listForUser(userId, limit);
  }

  @Post('dead-letter/:id/replay')
  @Throttle(THROTTLE_RULES.jobsPipelineStart)
  @ApiOperation({ summary: 'Replay a dead-letter job' })
  replayDeadLetter(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.deadLetterOrchestrator.replayForUser(id, userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a job by id' })
  findOne(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.jobsService.findOneForUser(id, userId);
  }

  @Patch(':id')
  @Throttle(THROTTLE_RULES.jobsUpdate)
  @ApiOperation({ summary: 'Update mutable job fields' })
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
  @ApiOperation({ summary: 'Delete a job' })
  remove(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.jobsService.removeForUser(id, userId);
  }

  @Post('pipeline/:id/start')
  @Throttle(THROTTLE_RULES.jobsPipelineStart)
  @ApiOperation({ summary: 'Start (or resume) pipeline for a project' })
  startPipeline(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.jobsService.startPipelineForUser(id, userId);
  }

  @Get('pipeline/:id')
  @ApiOperation({ summary: 'Get pipeline status for a project' })
  getPipelineStatus(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.jobsService.getPipelineStatusForUser(id, userId);
  }

  @Post('pipeline/:id/cancel')
  @Throttle(THROTTLE_RULES.jobsPipelineCancel)
  @ApiOperation({ summary: 'Cancel project pipeline' })
  cancelPipeline(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.jobsService.cancelPipelineForUser(id, userId);
  }
}
