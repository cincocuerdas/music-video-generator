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
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { THROTTLE_RULES } from '../../common/constants';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiEnvelopeCreatedResponse,
  ApiEnvelopeDefaultErrorResponses,
  ApiEnvelopeOkResponse,
} from '../../common/swagger/api-envelope.decorators';
import { serializeDto } from '../../common/utils/serialize-dto.util';
import { ProjectsService } from './projects.service';
import {
  AuthenticatedRequest,
  AuthService,
} from '../auth';
import {
  CreateProjectDto,
  UpdateProjectDto,
  StartGenerationDto,
  CreateFeedbackDto,
  SendLiveSignalDto,
  FeedbackActionResponseDto,
  FeedbackStatsResponseDto,
  LiveSignalActionResponseDto,
  LiveSignalDataResponseDto,
  ProjectActionResponseDto,
  ProjectDetailResponseDto,
  ProjectDownloadResponseDto,
  ProjectFeedbackResponseDto,
  ProjectListResponseDto,
  ProjectResponseDto,
  ProjectStartGenerationResponseDto,
  ProjectStatusResponseDto,
  ProjectVideoResponseDto,
  PromptOptimizationResponseDto,
} from './dto';

@Controller('projects')
@ApiTags('projects')
@ApiBearerAuth()
@ApiEnvelopeDefaultErrorResponses({ unauthorized: true, notFound: true })
export class ProjectsController {
  constructor(
    private readonly projectsService: ProjectsService,
    private readonly authService: AuthService,
  ) {}

  @Post()
  @Throttle(THROTTLE_RULES.projectsCreate)
  @ApiOperation({ summary: 'Create a project' })
  @ApiEnvelopeCreatedResponse('Project created')
  create(
    @Req() req: AuthenticatedRequest,
    @Body() createProjectDto: CreateProjectDto,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.projectsService.create(userId, createProjectDto).then((project) =>
      serializeDto(ProjectResponseDto, project),
    );
  }

  @Get()
  @ApiOperation({ summary: 'List user projects (paginated)' })
  @ApiEnvelopeOkResponse('Project list')
  findAll(
    @Req() req: AuthenticatedRequest,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.projectsService.findAll(userId, page, limit).then((projects) =>
      serializeDto(ProjectListResponseDto, projects),
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get project details' })
  @ApiEnvelopeOkResponse('Project details')
  findOne(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.projectsService.findOne(id, userId).then((project) =>
      serializeDto(ProjectDetailResponseDto, project),
    );
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update project metadata' })
  @ApiEnvelopeOkResponse('Project updated')
  update(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateProjectDto: UpdateProjectDto,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.projectsService.update(id, userId, updateProjectDto).then((project) =>
      serializeDto(ProjectResponseDto, project),
    );
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a project' })
  @ApiEnvelopeOkResponse('Project deleted')
  remove(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.projectsService.remove(id, userId).then((project) =>
      serializeDto(ProjectResponseDto, project),
    );
  }

  @Post(':id/generate')
  @Throttle(THROTTLE_RULES.projectsGenerate)
  @ApiOperation({ summary: 'Start generation pipeline for a project' })
  @ApiEnvelopeCreatedResponse('Generation pipeline started')
  startGeneration(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: StartGenerationDto,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.projectsService.startGeneration(id, userId, dto).then((result) =>
      serializeDto(ProjectStartGenerationResponseDto, result),
    );
  }

  @Get(':id/status')
  @ApiOperation({ summary: 'Get project generation status and progress' })
  @ApiEnvelopeOkResponse('Project generation status')
  getStatus(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.projectsService.getStatus(id, userId).then((status) =>
      serializeDto(ProjectStatusResponseDto, status),
    );
  }

  @Post(':id/cancel')
  @Throttle(THROTTLE_RULES.projectsCancel)
  @ApiOperation({ summary: 'Cancel active generation pipeline' })
  @ApiEnvelopeCreatedResponse('Generation pipeline cancelled')
  cancelGeneration(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.projectsService.cancelGeneration(id, userId).then((result) =>
      serializeDto(ProjectActionResponseDto, result),
    );
  }

  @Get(':id/video')
  @ApiOperation({ summary: 'Get rendered video metadata and URL' })
  @ApiEnvelopeOkResponse('Rendered video metadata')
  getVideo(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.projectsService.getVideo(id, userId).then((video) =>
      serializeDto(ProjectVideoResponseDto, video),
    );
  }

  @Get(':id/download')
  @ApiOperation({ summary: 'Get direct download URL for rendered video' })
  @ApiEnvelopeOkResponse('Rendered video download URL')
  getDownloadUrl(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.projectsService.getDownloadUrl(id, userId).then((download) =>
      serializeDto(ProjectDownloadResponseDto, download),
    );
  }

  @Post(':id/feedback')
  @Throttle(THROTTLE_RULES.projectsFeedback)
  @ApiOperation({ summary: 'Submit scene feedback (like/dislike)' })
  @ApiEnvelopeCreatedResponse('Scene feedback recorded')
  addFeedback(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateFeedbackDto,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.projectsService.addFeedback(id, userId, dto).then((result) =>
      serializeDto(FeedbackActionResponseDto, result),
    );
  }

  @Get(':id/feedback')
  @ApiOperation({ summary: 'List scene feedback entries for project' })
  @ApiEnvelopeOkResponse('Scene feedback list')
  getFeedback(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.projectsService.getFeedback(id, userId).then((feedback) =>
      serializeDto(ProjectFeedbackResponseDto, feedback),
    );
  }

  @Get('feedback/stats')
  @Throttle(THROTTLE_RULES.projectsFeedbackStats)
  @ApiOperation({ summary: 'Get aggregated feedback statistics by style' })
  @ApiEnvelopeOkResponse('Feedback statistics')
  getFeedbackStats(@Query('style') style?: string) {
    return this.projectsService.getFeedbackStats(style).then((stats) =>
      serializeDto(FeedbackStatsResponseDto, stats),
    );
  }

  @Get(':id/prompt-optimization')
  @Throttle(THROTTLE_RULES.projectsPromptOptimization)
  @ApiOperation({ summary: 'Get prompt optimization from embedding-based feedback' })
  @ApiEnvelopeOkResponse('Prompt optimization')
  getPromptOptimization(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('prompt') prompt?: string,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.projectsService.getPromptOptimization(id, userId, prompt).then((result) =>
      serializeDto(PromptOptimizationResponseDto, result),
    );
  }

  @Post(':id/live-signal')
  @Throttle(THROTTLE_RULES.projectsLiveSignal)
  @ApiOperation({ summary: 'Send live steering signal for in-flight generation' })
  @ApiEnvelopeCreatedResponse('Live signal stored')
  sendLiveSignal(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() signal: SendLiveSignalDto,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.projectsService.saveLiveSignal(id, userId, signal).then((result) =>
      serializeDto(LiveSignalActionResponseDto, result),
    );
  }

  @Get(':id/live-signal')
  @ApiOperation({ summary: 'Read current live steering signal' })
  @ApiEnvelopeOkResponse('Current live signal')
  getLiveSignal(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.projectsService.getLiveSignal(id, userId).then((result) =>
      result ? serializeDto(LiveSignalDataResponseDto, result) : null,
    );
  }

  @Delete(':id/live-signal')
  @ApiOperation({ summary: 'Clear current live steering signal' })
  @ApiEnvelopeOkResponse('Live signal cleared')
  clearLiveSignal(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const userId = this.authService.getUserIdFromRequest(req);
    return this.projectsService.clearLiveSignal(id, userId).then((result) =>
      serializeDto(ProjectActionResponseDto, result),
    );
  }
}
