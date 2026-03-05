import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { THROTTLE_RULES } from '../../common/constants';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiEnvelopeCreatedResponse,
  ApiEnvelopeDefaultErrorResponses,
  ApiEnvelopeOkResponse,
} from '../../common/swagger/api-envelope.decorators';
import { AuthService } from './auth.service';
import { AuthenticatedRequest } from './auth.types';
import { JwtAuthGuard } from './jwt-auth.guard';
import { LoginDevDto } from './dto/login-dev.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { LogoutDto } from './dto/logout.dto';

@Controller('auth')
@ApiTags('auth')
@ApiEnvelopeDefaultErrorResponses()
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('dev-token')
  @Throttle(THROTTLE_RULES.authDevToken)
  @ApiOperation({ summary: 'Issue development token (dev only)' })
  @ApiEnvelopeCreatedResponse('Development token issued')
  createDevToken(@Body() dto: LoginDevDto) {
    return this.authService.issueDevToken(dto);
  }

  @Post('login/dev')
  @Throttle(THROTTLE_RULES.authLoginDev)
  @ApiOperation({ summary: 'Login with development identity and issue session tokens' })
  @ApiEnvelopeCreatedResponse('Development session created')
  loginDev(@Req() req: AuthenticatedRequest, @Body() dto: LoginDevDto) {
    return this.authService.loginDev(dto, {
      ipAddress: req.ip,
      userAgent: req.header('user-agent') || undefined,
    });
  }

  @Post('refresh')
  @HttpCode(200)
  @Throttle(THROTTLE_RULES.authRefresh)
  @ApiOperation({ summary: 'Refresh access token' })
  @ApiEnvelopeOkResponse('Access token refreshed')
  refresh(@Req() req: AuthenticatedRequest, @Body() dto: RefreshTokenDto) {
    return this.authService.refreshSession(dto.refreshToken, {
      ipAddress: req.ip,
      userAgent: req.header('user-agent') || undefined,
    });
  }

  @Post('logout')
  @HttpCode(200)
  @Throttle(THROTTLE_RULES.authLogout)
  @ApiOperation({ summary: 'Revoke refresh token and logout session' })
  @ApiEnvelopeOkResponse('Session revoked')
  logout(@Body() dto: LogoutDto) {
    return this.authService.logout(dto.refreshToken);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @Throttle(THROTTLE_RULES.authMe)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current authenticated user claims' })
  @ApiEnvelopeDefaultErrorResponses({ unauthorized: true, badRequest: false })
  @ApiEnvelopeOkResponse('Authenticated user claims')
  getMe(@Req() req: AuthenticatedRequest) {
    const userId = this.authService.getUserIdFromRequest(req);
    return {
      userId,
      claims: req.user?.claims ?? {},
    };
  }
}
