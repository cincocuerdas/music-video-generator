import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { THROTTLE_RULES } from '../../common/constants';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import {
  ApiEnvelopeCreatedResponse,
  ApiEnvelopeDefaultErrorResponses,
  ApiEnvelopeOkResponse,
} from '../../common/swagger/api-envelope.decorators';
import { AuthService } from './auth.service';
import { AuthenticatedRequest } from './auth.types';
import { Public } from './public.decorator';
import { LoginDevDto } from './dto/login-dev.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { LogoutDto } from './dto/logout.dto';

@Controller('auth')
@ApiTags('auth')
@ApiEnvelopeDefaultErrorResponses()
export class AuthController {
  private readonly refreshCookieName =
    (process.env.AUTH_REFRESH_COOKIE_NAME || 'mvg_refresh_token').trim() ||
    'mvg_refresh_token';

  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('dev-token')
  @Throttle(THROTTLE_RULES.authDevToken)
  @ApiOperation({ summary: 'Issue development token (dev only)' })
  @ApiEnvelopeCreatedResponse('Development token issued')
  createDevToken(@Body() dto: LoginDevDto) {
    return this.authService.issueDevToken(dto);
  }

  @Public()
  @Post('login/dev')
  @Throttle(THROTTLE_RULES.authLoginDev)
  @ApiOperation({ summary: 'Login with development identity and issue session tokens' })
  @ApiEnvelopeCreatedResponse('Development session created')
  async loginDev(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: LoginDevDto,
  ) {
    const result = await this.authService.loginDev(dto, {
      ipAddress: req.ip,
      userAgent: req.header('user-agent') || undefined,
    });
    this.setRefreshCookie(res, result.refreshToken);
    return this.withoutRefreshToken(result);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @Throttle(THROTTLE_RULES.authRefresh)
  @ApiOperation({ summary: 'Refresh access token' })
  @ApiEnvelopeOkResponse('Access token refreshed')
  async refresh(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: RefreshTokenDto,
  ) {
    const refreshToken = this.resolveRefreshToken(req, dto.refreshToken);
    const result = await this.authService.refreshSession(refreshToken, {
      ipAddress: req.ip,
      userAgent: req.header('user-agent') || undefined,
    });
    this.setRefreshCookie(res, result.refreshToken);
    return this.withoutRefreshToken(result);
  }

  @Public()
  @Post('logout')
  @HttpCode(200)
  @Throttle(THROTTLE_RULES.authLogout)
  @ApiOperation({ summary: 'Revoke refresh token and logout session' })
  @ApiEnvelopeOkResponse('Session revoked')
  async logout(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: LogoutDto,
  ) {
    const refreshToken = this.resolveRefreshToken(req, dto.refreshToken);
    const result = await this.authService.logout(refreshToken);
    this.clearRefreshCookie(res);
    return result;
  }

  @Get('me')
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

  private resolveRefreshToken(
    req: AuthenticatedRequest,
    bodyToken?: string,
  ): string {
    const normalizedBodyToken = typeof bodyToken === 'string' ? bodyToken.trim() : '';
    if (normalizedBodyToken) {
      return normalizedBodyToken;
    }

    const cookies = this.parseCookieHeader(req.header('cookie'));
    return cookies[this.refreshCookieName] || '';
  }

  private parseCookieHeader(cookieHeader?: string): Record<string, string> {
    if (!cookieHeader) {
      return {};
    }

    return cookieHeader.split(';').reduce<Record<string, string>>((acc, pair) => {
      const separatorIndex = pair.indexOf('=');
      if (separatorIndex <= 0) {
        return acc;
      }

      const key = pair.slice(0, separatorIndex).trim();
      const value = pair.slice(separatorIndex + 1).trim();
      if (!key) {
        return acc;
      }

      acc[key] = decodeURIComponent(value);
      return acc;
    }, {});
  }

  private setRefreshCookie(res: Response, refreshToken: string): void {
    res.cookie(this.refreshCookieName, refreshToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.isSecureCookieEnabled(),
      path: '/api/v1/auth',
    });
  }

  private clearRefreshCookie(res: Response): void {
    res.clearCookie(this.refreshCookieName, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.isSecureCookieEnabled(),
      path: '/api/v1/auth',
    });
  }

  private isSecureCookieEnabled(): boolean {
    const raw = process.env.AUTH_REFRESH_COOKIE_SECURE?.trim().toLowerCase();
    if (raw === 'true') {
      return true;
    }
    if (raw === 'false') {
      return false;
    }
    return (process.env.NODE_ENV || '').trim().toLowerCase() === 'production';
  }

  private withoutRefreshToken<T extends { refreshToken?: string }>(
    payload: T,
  ): Omit<T, 'refreshToken'> {
    const { refreshToken: _refreshToken, ...safePayload } = payload;
    return safePayload;
  }
}
