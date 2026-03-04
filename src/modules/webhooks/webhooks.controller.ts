import { Body, Controller, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { RawBodyRequest } from '@nestjs/common';
import { Request } from 'express';
import { THROTTLE_RULES } from '../../common/constants';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { WebhooksService } from './webhooks.service';

@Controller('webhooks')
@ApiTags('webhooks')
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  @Post('health-alert')
  @Throttle(THROTTLE_RULES.webhooksHealthAlert)
  @ApiOperation({ summary: 'Receive signed health alert webhook' })
  receiveHealthAlert(
    @Req() req: RawBodyRequest<Request>,
    @Body() _body: unknown,
  ): Record<string, unknown> {
    const rawBody =
      typeof req.rawBody === 'string'
        ? req.rawBody
        : req.rawBody instanceof Buffer
          ? req.rawBody.toString('utf8')
          : JSON.stringify(_body || {});

    return this.webhooksService.receiveHealthAlert(
      rawBody,
      req.headers as Record<string, string | string[] | undefined>,
    );
  }
}
