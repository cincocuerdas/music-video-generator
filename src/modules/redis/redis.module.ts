import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RedisClientService } from './redis-client.service';
import { RedisThrottlerStorageService } from './redis-throttler-storage.service';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [RedisClientService, RedisThrottlerStorageService],
  exports: [RedisClientService, RedisThrottlerStorageService],
})
export class RedisModule {}
