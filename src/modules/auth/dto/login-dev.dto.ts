import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class LoginDevDto {
  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(320)
  email?: string;
}
