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
import { AuthService } from './auth.service';
import { AuthenticatedRequest } from './auth.types';
import { JwtAuthGuard } from './jwt-auth.guard';
import { LoginDevDto } from './dto/login-dev.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { LogoutDto } from './dto/logout.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('dev-token')
  @Throttle(THROTTLE_RULES.authDevToken)
  createDevToken(@Body() dto: LoginDevDto) {
    return this.authService.issueDevToken(dto);
  }

  @Post('login/dev')
  @Throttle(THROTTLE_RULES.authLoginDev)
  loginDev(@Req() req: AuthenticatedRequest, @Body() dto: LoginDevDto) {
    return this.authService.loginDev(dto, {
      ipAddress: req.ip,
      userAgent: req.header('user-agent') || undefined,
    });
  }

  @Post('refresh')
  @HttpCode(200)
  @Throttle(THROTTLE_RULES.authRefresh)
  refresh(@Req() req: AuthenticatedRequest, @Body() dto: RefreshTokenDto) {
    return this.authService.refreshSession(dto.refreshToken, {
      ipAddress: req.ip,
      userAgent: req.header('user-agent') || undefined,
    });
  }

  @Post('logout')
  @HttpCode(200)
  @Throttle(THROTTLE_RULES.authLogout)
  logout(@Body() dto: LogoutDto) {
    return this.authService.logout(dto.refreshToken);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @Throttle(THROTTLE_RULES.authMe)
  getMe(@Req() req: AuthenticatedRequest) {
    const userId = this.authService.getUserIdFromRequest(req);
    return {
      userId,
      claims: req.user?.claims ?? {},
    };
  }
}
