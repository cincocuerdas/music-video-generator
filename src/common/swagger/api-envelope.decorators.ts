import { applyDecorators } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCreatedResponse,
  ApiInternalServerErrorResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

const envelopeMetaSchema = {
  type: 'object',
  properties: {
    timestamp: { type: 'string', format: 'date-time' },
    correlationId: { type: 'string', nullable: true },
    path: { type: 'string', nullable: true },
  },
};

const envelopeErrorSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', example: false },
    error: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 400 },
        message: {
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          example: 'Bad Request',
        },
      },
    },
    meta: envelopeMetaSchema,
  },
};

function buildEnvelopeSuccessSchema(description: string) {
  return {
    description,
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean', example: true },
        data: { type: 'object', additionalProperties: true },
        meta: envelopeMetaSchema,
      },
    },
  };
}

export function ApiEnvelopeOkResponse(description = 'Successful response') {
  return ApiOkResponse(buildEnvelopeSuccessSchema(description));
}

export function ApiEnvelopeCreatedResponse(description = 'Resource created') {
  return ApiCreatedResponse(buildEnvelopeSuccessSchema(description));
}

export function ApiEnvelopeDefaultErrorResponses(options?: {
  badRequest?: boolean;
  unauthorized?: boolean;
  notFound?: boolean;
}) {
  const decorators = [
    ApiInternalServerErrorResponse({
      description: 'Internal server error',
      schema: envelopeErrorSchema,
    }),
  ];

  if (options?.badRequest !== false) {
    decorators.push(
      ApiBadRequestResponse({
        description: 'Bad request',
        schema: envelopeErrorSchema,
      }),
    );
  }

  if (options?.unauthorized) {
    decorators.push(
      ApiUnauthorizedResponse({
        description: 'Unauthorized',
        schema: envelopeErrorSchema,
      }),
    );
  }

  if (options?.notFound) {
    decorators.push(
      ApiNotFoundResponse({
        description: 'Not found',
        schema: envelopeErrorSchema,
      }),
    );
  }

  return applyDecorators(...decorators);
}
