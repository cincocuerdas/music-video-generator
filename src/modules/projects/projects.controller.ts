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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
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
@ApiTags('projects')
@ApiBearerAuth()
export class ProjectsController {
  constructor(
    private readonly projectsService: ProjectsService,
    private readonly authService: AuthService,
  ) {}

  @Post()
  @Throttle(THROTTLE_RULES.projectsCreate)
  @ApiOperation({ summary: 'Create a project' })
  create(
    @Req() req: AuthenticatedRequest,
    @Body() createProjectDto: CreateProjectDto,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.projectsService.create(userId, createProjectDto);
  }

  @Get()
  @ApiOperation({ summary: 'List user projects (paginated)' })
  findAll(
    @Req() req: AuthenticatedRequest,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.projectsService.findAll(userId, page, limit);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get project details' })
  findOne(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.projectsService.findOne(id, userId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update project metadata' })
  update(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateProjectDto: UpdateProjectDto,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.projectsService.update(id, userId, updateProjectDto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a project' })
  remove(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.projectsService.remove(id, userId);
  }

  @Post(':id/generate')
  @Throttle(THROTTLE_RULES.projectsGenerate)
  @ApiOperation({ summary: 'Start generation pipeline for a project' })
  startGeneration(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: StartGenerationDto,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.projectsService.startGeneration(id, userId, dto);
  }

  @Get(':id/status')
  @ApiOperation({ summary: 'Get project generation status and progress' })
  getStatus(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.projectsService.getStatus(id, userId);
  }

  @Post(':id/cancel')
  @Throttle(THROTTLE_RULES.projectsCancel)
  @ApiOperation({ summary: 'Cancel active generation pipeline' })
  cancelGeneration(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.projectsService.cancelGeneration(id, userId);
  }

  @Get(':id/video')
  @ApiOperation({ summary: 'Get rendered video metadata and URL' })
  getVideo(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.projectsService.getVideo(id, userId);
  }

  @Get(':id/download')
  @ApiOperation({ summary: 'Get direct download URL for rendered video' })
  getDownloadUrl(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.projectsService.getDownloadUrl(id, userId);
  }

  @Post(':id/feedback')
  @Throttle(THROTTLE_RULES.projectsFeedback)
  @ApiOperation({ summary: 'Submit scene feedback (like/dislike)' })
  addFeedback(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateFeedbackDto,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.projectsService.addFeedback(id, userId, dto);
  }

  @Get(':id/feedback')
  @ApiOperation({ summary: 'List scene feedback entries for project' })
  getFeedback(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.projectsService.getFeedback(id, userId);
  }

  @Get('feedback/stats')
  @Throttle(THROTTLE_RULES.projectsFeedbackStats)
  @ApiOperation({ summary: 'Get aggregated feedback statistics by style' })
  getFeedbackStats(@Query('style') style?: string) {
    return this.projectsService.getFeedbackStats(style);
  }

  @Get(':id/prompt-optimization')
  @Throttle(THROTTLE_RULES.projectsPromptOptimization)
  @ApiOperation({ summary: 'Get prompt optimization from embedding-based feedback' })
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
  @ApiOperation({ summary: 'Send live steering signal for in-flight generation' })
  sendLiveSignal(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() signal: SendLiveSignalDto,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.projectsService.saveLiveSignal(id, userId, signal);
  }

  @Get(':id/live-signal')
  @ApiOperation({ summary: 'Read current live steering signal' })
  getLiveSignal(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.projectsService.getLiveSignal(id, userId);
  }

  @Delete(':id/live-signal')
  @ApiOperation({ summary: 'Clear current live steering signal' })
  clearLiveSignal(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.projectsService.clearLiveSignal(id, userId);
  }
}
