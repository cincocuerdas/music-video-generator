import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RedisClientService } from './redis-client.service';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [RedisClientService],
  exports: [RedisClientService],
})
export class RedisModule {}

