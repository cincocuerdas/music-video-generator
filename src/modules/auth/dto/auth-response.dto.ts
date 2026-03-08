import { Expose } from 'class-transformer';

export class DevTokenResponseDto {
  @Expose()
  token!: string;

  @Expose()
  userId!: string;

  @Expose()
  tokenType!: string;

  @Expose()
  expiresIn!: string | number;
}

export class AuthLoginResponseDto {
  @Expose()
  userId!: string;

  @Expose()
  accessToken!: string;

  @Expose()
  accessExpiresIn!: string | number;

  @Expose()
  refreshExpiresIn!: string | number;
}

export class AuthRefreshResponseDto {
  @Expose()
  accessToken!: string;

  @Expose()
  accessExpiresIn!: string | number;

  @Expose()
  refreshExpiresIn!: string | number;
}

export class LogoutResponseDto {
  @Expose()
  success!: boolean;
}

export class AuthMeResponseDto {
  @Expose()
  userId!: string;

  @Expose()
  claims!: Record<string, unknown>;
}
