import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  Req,
  ParseUUIDPipe,
  ParseIntPipe,
  DefaultValuePipe,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { THROTTLE_RULES } from '../../common/constants';
import { ProjectsService } from './projects.service';
import {
  AuthenticatedRequest,
  AuthService,
  JwtAuthGuard,
} from '../auth';
import {
  CreateProjectDto,
  UpdateProjectDto,
  StartGenerationDto,
  CreateFeedbackDto,
  SendLiveSignalDto,
} from './dto';

@Controller('projects')
@UseGuards(JwtAuthGuard)
export class ProjectsController {
  constructor(
    private readonly projectsService: ProjectsService,
    private readonly authService: AuthService,
  ) {}

  @Post()
  @Throttle(THROTTLE_RULES.projectsCreate)
  create(
    @Req() req: AuthenticatedRequest,
    @Body() createProjectDto: CreateProjectDto,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.projectsService.create(userId, createProjectDto);
  }

  @Get()
  findAll(
    @Req() req: AuthenticatedRequest,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.projectsService.findAll(userId, page, limit);
  }

  @Get(':id')
  findOne(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.projectsService.findOne(id, userId);
  }

  @Patch(':id')
  update(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateProjectDto: UpdateProjectDto,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.projectsService.update(id, userId, updateProjectDto);
  }

  @Delete(':id')
  remove(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.projectsService.remove(id, userId);
  }

  @Post(':id/generate')
  @Throttle(THROTTLE_RULES.projectsGenerate)
  startGeneration(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: StartGenerationDto,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.projectsService.startGeneration(id, userId, dto);
  }

  @Get(':id/status')
  getStatus(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.projectsService.getStatus(id, userId);
  }

  @Post(':id/cancel')
  @Throttle(THROTTLE_RULES.projectsCancel)
  cancelGeneration(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.projectsService.cancelGeneration(id, userId);
  }

  @Get(':id/video')
  getVideo(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.projectsService.getVideo(id, userId);
  }

  @Get(':id/download')
  getDownloadUrl(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.projectsService.getDownloadUrl(id, userId);
  }

  @Post(':id/feedback')
  @Throttle(THROTTLE_RULES.projectsFeedback)
  addFeedback(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateFeedbackDto,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.projectsService.addFeedback(id, userId, dto);
  }

  @Get(':id/feedback')
  getFeedback(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.projectsService.getFeedback(id, userId);
  }

  @Get('feedback/stats')
  @Throttle(THROTTLE_RULES.projectsFeedbackStats)
  getFeedbackStats(@Query('style') style?: string) {
    return this.projectsService.getFeedbackStats(style);
  }

  @Get(':id/prompt-optimization')
  @Throttle(THROTTLE_RULES.projectsPromptOptimization)
  getPromptOptimization(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('prompt') prompt?: string,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.projectsService.getPromptOptimization(id, userId, prompt);
  }

  @Post(':id/live-signal')
  @Throttle(THROTTLE_RULES.projectsLiveSignal)
  sendLiveSignal(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() signal: SendLiveSignalDto,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.projectsService.saveLiveSignal(id, userId, signal);
  }

  @Get(':id/live-signal')
  getLiveSignal(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.projectsService.getLiveSignal(id, userId);
  }

  @Delete(':id/live-signal')
  clearLiveSignal(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.projectsService.clearLiveSignal(id, userId);
  }
}
