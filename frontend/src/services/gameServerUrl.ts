export interface GameServerUrlOptions {
  configuredUrl?: string;
  isProduction: boolean;
  browserOrigin?: string;
}

export function resolveGameServerUrl({
  configuredUrl,
  isProduction,
  browserOrigin,
}: GameServerUrlOptions): string | undefined {
  if (configuredUrl) return configuredUrl;
  return isProduction ? browserOrigin : undefined;
}
