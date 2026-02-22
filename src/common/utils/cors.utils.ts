export interface ResolvedCorsConfig {
  origins: string[];
  allowWildcard: boolean;
  socketOrigin: true | string[];
}

export function resolveCorsConfig(rawCorsOrigin: string | undefined): ResolvedCorsConfig {
  const origins = (rawCorsOrigin || '*')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  const allowWildcard = origins.includes('*');
  return {
    origins: allowWildcard ? [] : origins,
    allowWildcard,
    socketOrigin: allowWildcard ? true : origins,
  };
}

