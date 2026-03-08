import { ClassConstructor, plainToInstance } from 'class-transformer';

const SERIALIZE_OPTIONS = {
  excludeExtraneousValues: true,
  exposeUnsetFields: false,
} as const;

export function serializeDto<T, V>(
  dtoClass: ClassConstructor<T>,
  payload: V,
): T {
  return plainToInstance(dtoClass, payload, SERIALIZE_OPTIONS);
}

export function serializeDtoArray<T, V>(
  dtoClass: ClassConstructor<T>,
  payload: V[],
): T[] {
  return plainToInstance(dtoClass, payload, SERIALIZE_OPTIONS);
}
