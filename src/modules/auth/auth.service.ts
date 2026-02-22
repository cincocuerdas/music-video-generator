import {
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtPayload, sign, verify } from 'jsonwebtoken';
import { Request } from 'express';
import { randomUUID, createHash } from 'crypto';
import { Socket } from 'socket.io';
import type { StringValue } from 'ms';
import { AuthenticatedRequest, AuthenticatedUser } from './auth.types';
import { PrismaService } from '../prisma';
import { LoginDevDto } from './dto/login-dev.dto';

interface SessionContext {
  ipAddress?: string;
  userAgent?: string;
}

export interface TokenPairResult {
  userId: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresIn: string | number;
  refreshExpiresIn: string | number;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  constructor(private readonly prisma: PrismaService) {}

  async issueDevToken(dto: LoginDevDto) {
    this.assertDevAuthEndpointAllowed();
    const userId = this.resolveDevUserId(dto);
    await this.upsertDevUser(userId, dto);
    const expiresIn = this.resolveJwtExpiry(process.env.JWT_EXPIRES_IN, '1h');
    const token = this.signAccessToken(userId, expiresIn);

    return {
      token,
      userId,
      tokenType: 'Bearer',
      expiresIn,
    };
  }

  async loginDev(dto: LoginDevDto, context: SessionContext): Promise<TokenPairResult> {
    this.assertDevAuthEndpointAllowed();
    const userId = this.resolveDevUserId(dto);
    await this.upsertDevUser(userId, dto);

    return this.issueTokenPair(userId, context);
  }

  async refreshSession(
    refreshToken: string,
    context: SessionContext,
  ): Promise<TokenPairResult> {
    const payload = this.verifyRefreshToken(refreshToken);
    const userId = this.resolveUserIdFromPayload(payload);
    const sessionId =
      typeof payload.sid === 'string' && this.uuidRegex.test(payload.sid)
        ? payload.sid
        : null;

    if (!sessionId) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const session = await this.prisma.authSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        userId: true,
        tokenHash: true,
        revokedAt: true,
        expiresAt: true,
      },
    });

    if (!session || session.userId !== userId) {
      throw new UnauthorizedException('Invalid refresh session');
    }

    if (session.revokedAt || session.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Refresh session expired');
    }

    const refreshTokenHash = this.hashToken(refreshToken);
    if (refreshTokenHash !== session.tokenHash) {
      await this.prisma.authSession.update({
        where: { id: session.id },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException('Invalid refresh token');
    }

    const accessExpiresIn = this.resolveJwtExpiry(
      process.env.JWT_EXPIRES_IN,
      '1h',
    );
    const refreshExpiresIn = this.resolveJwtExpiry(
      process.env.JWT_REFRESH_EXPIRES_IN,
      '30d',
    );

    const accessToken = this.signAccessToken(userId, accessExpiresIn);
    const nextRefreshToken = this.signRefreshToken(
      userId,
      sessionId,
      refreshExpiresIn,
    );
    const nextRefreshPayload = this.verifyRefreshToken(nextRefreshToken);
    const nextRefreshExpiresAt = this.extractExpiryDate(nextRefreshPayload);

    await this.prisma.authSession.update({
      where: { id: session.id },
      data: {
        tokenHash: this.hashToken(nextRefreshToken),
        expiresAt: nextRefreshExpiresAt,
        revokedAt: null,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
      },
    });

    return {
      userId,
      accessToken,
      refreshToken: nextRefreshToken,
      accessExpiresIn,
      refreshExpiresIn,
    };
  }

  async logout(refreshToken?: string) {
    if (!refreshToken) {
      return { success: true };
    }

    try {
      const payload = this.verifyRefreshToken(refreshToken);
      const userId = this.resolveUserIdFromPayload(payload);
      const sessionId =
        typeof payload.sid === 'string' && this.uuidRegex.test(payload.sid)
          ? payload.sid
          : null;
      if (!sessionId) {
        return { success: true };
      }

      await this.prisma.authSession.updateMany({
        where: { id: sessionId, userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    } catch {
      // Logout should be idempotent.
    }

    return { success: true };
  }

  authenticateRequest(req: Request): AuthenticatedUser {
    const token = this.extractHttpToken(req);
    if (token) {
      return this.authenticateToken(token);
    }

    const fallbackUserId = this.resolveDevFallbackUserId();
    if (fallbackUserId) {
      return {
        userId: fallbackUserId,
        token: '__dev_bypass__',
        claims: { sub: fallbackUserId, source: 'dev-bypass' },
      };
    }

    throw new UnauthorizedException('Missing bearer token');
  }

  authenticateSocket(client: Socket): AuthenticatedUser {
    const token = this.extractSocketToken(client);
    if (token) {
      return this.authenticateToken(token);
    }

    const fallbackUserId = this.resolveDevFallbackUserId();
    if (fallbackUserId) {
      return {
        userId: fallbackUserId,
        token: '__dev_bypass__',
        claims: { sub: fallbackUserId, source: 'dev-bypass' },
      };
    }

    throw new UnauthorizedException('Missing websocket auth token');
  }

  getUserIdFromRequest(req: AuthenticatedRequest): string {
    const userId = req.user?.userId;
    if (!userId) {
      throw new UnauthorizedException('Missing authenticated user');
    }
    return userId;
  }

  private async issueTokenPair(
    userId: string,
    context: SessionContext,
  ): Promise<TokenPairResult> {
    const accessExpiresIn = this.resolveJwtExpiry(
      process.env.JWT_EXPIRES_IN,
      '1h',
    );
    const refreshExpiresIn = this.resolveJwtExpiry(
      process.env.JWT_REFRESH_EXPIRES_IN,
      '30d',
    );
    const sessionId = randomUUID();

    const accessToken = this.signAccessToken(userId, accessExpiresIn);
    const refreshToken = this.signRefreshToken(userId, sessionId, refreshExpiresIn);
    const refreshPayload = this.verifyRefreshToken(refreshToken);
    const refreshExpiresAt = this.extractExpiryDate(refreshPayload);

    await this.prisma.authSession.create({
      data: {
        id: sessionId,
        userId,
        tokenHash: this.hashToken(refreshToken),
        expiresAt: refreshExpiresAt,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
      },
    });

    return {
      userId,
      accessToken,
      refreshToken,
      accessExpiresIn,
      refreshExpiresIn,
    };
  }

  private authenticateToken(token: string): AuthenticatedUser {
    const payload = this.verifyAccessToken(token);
    const userId = this.resolveUserIdFromPayload(payload);

    return {
      userId,
      token,
      claims: payload,
    };
  }

  private verifyAccessToken(token: string): Record<string, unknown> {
    try {
      const decoded = verify(token, this.getAccessSecret(), {
        algorithms: ['HS256', 'HS384', 'HS512'],
      });

      if (typeof decoded === 'string') {
        throw new UnauthorizedException('Invalid JWT payload');
      }

      return decoded as JwtPayload as Record<string, unknown>;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  private verifyRefreshToken(token: string): Record<string, unknown> {
    try {
      const decoded = verify(token, this.getRefreshSecret(), {
        algorithms: ['HS256', 'HS384', 'HS512'],
      });

      if (typeof decoded === 'string') {
        throw new UnauthorizedException('Invalid refresh token');
      }

      return decoded as JwtPayload as Record<string, unknown>;
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
  }

  private signAccessToken(
    userId: string,
    expiresIn: string | number,
  ): string {
    const userIdClaim = (process.env.JWT_USER_ID_CLAIM || 'sub').trim();
    const payload: Record<string, unknown> = {
      sub: userId,
      role: 'user',
    };

    if (userIdClaim !== 'sub') {
      payload[userIdClaim] = userId;
    }

    return sign(payload, this.getAccessSecret(), {
      algorithm: 'HS256',
      expiresIn: expiresIn as any,
    });
  }

  private signRefreshToken(
    userId: string,
    sessionId: string,
    expiresIn: string | number,
  ): string {
    return sign(
      {
        sub: userId,
        sid: sessionId,
        type: 'refresh',
      },
      this.getRefreshSecret(),
      {
        algorithm: 'HS256',
        expiresIn: expiresIn as any,
      },
    );
  }

  private getAccessSecret(): string {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      this.logger.error('JWT_SECRET is not configured.');
      throw new UnauthorizedException('Auth is not configured');
    }
    return secret;
  }

  private getRefreshSecret(): string {
    return process.env.JWT_REFRESH_SECRET || this.getAccessSecret();
  }

  private resolveUserIdFromPayload(payload: Record<string, unknown>): string {
    const configuredClaim = (process.env.JWT_USER_ID_CLAIM || 'sub').trim();
    const candidates = [
      payload[configuredClaim],
      payload.sub,
      payload.userId,
      payload.user_id,
      payload.uid,
    ];

    const userId = candidates.find((value) => typeof value === 'string') as
      | string
      | undefined;

    if (!userId || !this.uuidRegex.test(userId)) {
      throw new UnauthorizedException(
        `Token does not include a valid UUID user claim (${configuredClaim})`,
      );
    }

    return userId;
  }

  private extractExpiryDate(payload: Record<string, unknown>): Date {
    const exp = payload.exp;
    if (typeof exp !== 'number') {
      throw new UnauthorizedException('Token is missing exp claim');
    }
    return new Date(exp * 1000);
  }

  private resolveJwtExpiry(
    value: string | undefined,
    fallback: StringValue,
  ): string | number {
    const normalized = (value || fallback).trim();
    if (/^\d+$/.test(normalized)) {
      return Number(normalized);
    }

    return normalized as StringValue;
  }

  private hashToken(token: string): string {
    return createHash('sha256')
      .update(token)
      .update(this.getTokenPepper())
      .digest('hex');
  }

  private getTokenPepper(): string {
    return (
      process.env.JWT_REFRESH_TOKEN_PEPPER ||
      process.env.JWT_REFRESH_SECRET ||
      process.env.JWT_SECRET ||
      ''
    );
  }

  private extractHttpToken(req: Request): string | null {
    const authorizationHeader = req.header('authorization');
    return this.extractBearerToken(authorizationHeader);
  }

  private extractSocketToken(client: Socket): string | null {
    const handshakeAuthToken =
      typeof client.handshake.auth?.token === 'string'
        ? client.handshake.auth.token.trim()
        : null;
    if (handshakeAuthToken) {
      return handshakeAuthToken;
    }

    const handshakeAuthorization =
      typeof client.handshake.auth?.authorization === 'string'
        ? client.handshake.auth.authorization.trim()
        : null;
    const headerAuthorization =
      typeof client.handshake.headers.authorization === 'string'
        ? client.handshake.headers.authorization.trim()
        : null;

    return this.extractBearerToken(handshakeAuthorization || headerAuthorization);
  }

  private extractBearerToken(value?: string | null): string | null {
    if (!value) {
      return null;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    const match = /^Bearer\s+(.+)$/i.exec(trimmed);
    return match?.[1]?.trim() || null;
  }

  private resolveDevFallbackUserId(): string | null {
    if (!this.isDevBypassEnabled()) {
      return null;
    }

    const fallbackUserId =
      process.env.DEV_USER_ID || '00000000-0000-4000-8000-000000000001';
    if (!this.uuidRegex.test(fallbackUserId)) {
      this.logger.warn(
        `Ignoring invalid DEV_USER_ID value: "${fallbackUserId}". Expected UUID.`,
      );
      return null;
    }

    return fallbackUserId;
  }

  private isDevBypassEnabled(): boolean {
    if ((process.env.NODE_ENV || 'development') === 'production') {
      return false;
    }

    const value = process.env.ALLOW_DEV_AUTH_BYPASS;
    if (typeof value === 'undefined') {
      return false;
    }

    return value.toLowerCase() === 'true';
  }

  private assertDevAuthEndpointAllowed() {
    if ((process.env.NODE_ENV || 'development') === 'production') {
      throw new ForbiddenException('Dev auth endpoint is disabled in production');
    }
  }

  private resolveDevUserId(dto: LoginDevDto): string {
    const requestUserId =
      typeof dto.userId === 'string' ? dto.userId.trim() : '';
    if (requestUserId) {
      if (!this.uuidRegex.test(requestUserId)) {
        throw new ForbiddenException('Invalid userId. Expected UUID.');
      }
      return requestUserId;
    }

    const envUserId =
      typeof process.env.DEV_USER_ID === 'string'
        ? process.env.DEV_USER_ID.trim()
        : '';
    if (envUserId) {
      if (this.uuidRegex.test(envUserId)) {
        return envUserId;
      }
      this.logger.warn(
        `Ignoring invalid DEV_USER_ID value "${envUserId}" and using default dev UUID.`,
      );
    }

    return '00000000-0000-4000-8000-000000000001';
  }

  private async upsertDevUser(userId: string, dto: LoginDevDto): Promise<void> {
    await this.prisma.user.upsert({
      where: { id: userId },
      update: {
        ...(dto.name ? { name: dto.name } : {}),
        ...(dto.email ? { email: dto.email } : {}),
      },
      create: {
        id: userId,
        name: dto.name || 'Dev User',
        ...(dto.email ? { email: dto.email } : {}),
      },
    });
  }
}
