import { RoomServiceError } from "./room-service.js";

export interface RateLimitRule {
  readonly max: number;
  readonly windowMs: number;
}

export interface ResourceLimits {
  readonly maxInboundMessageBytes: number;
  readonly maxCanvasActionsPerRoom: number;
  readonly roomCleanupIntervalMs: number;
  readonly drawingPerSession: RateLimitRule;
  readonly drawingPerRoom: RateLimitRule;
  readonly submissionsPerSession: RateLimitRule;
  readonly submissionsPerRoom: RateLimitRule;
  readonly reactionsPerSession: RateLimitRule;
  readonly roomCreatesPerConnection: RateLimitRule;
  readonly roomCodeGuessesPerConnection: RateLimitRule;
  readonly roomCodeGuessesPerCode: RateLimitRule;
}

export type ResourceLimitOptions = Partial<{
  [Key in keyof ResourceLimits]: ResourceLimits[Key] extends RateLimitRule
    ? Partial<RateLimitRule>
    : ResourceLimits[Key];
}> & { now?: () => number };

export const DEFAULT_RESOURCE_LIMITS: ResourceLimits = {
  maxInboundMessageBytes: 512 * 1024,
  maxCanvasActionsPerRoom: 50_000,
  roomCleanupIntervalMs: 60_000,
  drawingPerSession: { max: 240, windowMs: 10_000 },
  drawingPerRoom: { max: 10_000, windowMs: 10_000 },
  submissionsPerSession: { max: 20, windowMs: 60_000 },
  submissionsPerRoom: { max: 2_000, windowMs: 60_000 },
  reactionsPerSession: { max: 6, windowMs: 3_000 },
  roomCreatesPerConnection: { max: 5, windowMs: 60_000 },
  roomCodeGuessesPerConnection: { max: 30, windowMs: 60_000 },
  roomCodeGuessesPerCode: { max: 200, windowMs: 60_000 },
};

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function rateRule(
  name: string,
  fallback: RateLimitRule,
  override: Partial<RateLimitRule> | undefined,
): RateLimitRule {
  return {
    max: positiveInteger(override?.max ?? fallback.max, `${name}.max`),
    windowMs: positiveInteger(
      override?.windowMs ?? fallback.windowMs,
      `${name}.windowMs`,
    ),
  };
}

export function resolveResourceLimits(options: ResourceLimitOptions = {}): ResourceLimits {
  return {
    maxInboundMessageBytes: positiveInteger(
      options.maxInboundMessageBytes ?? DEFAULT_RESOURCE_LIMITS.maxInboundMessageBytes,
      "maxInboundMessageBytes",
    ),
    maxCanvasActionsPerRoom: positiveInteger(
      options.maxCanvasActionsPerRoom ?? DEFAULT_RESOURCE_LIMITS.maxCanvasActionsPerRoom,
      "maxCanvasActionsPerRoom",
    ),
    roomCleanupIntervalMs: positiveInteger(
      options.roomCleanupIntervalMs ?? DEFAULT_RESOURCE_LIMITS.roomCleanupIntervalMs,
      "roomCleanupIntervalMs",
    ),
    drawingPerSession: rateRule(
      "drawingPerSession",
      DEFAULT_RESOURCE_LIMITS.drawingPerSession,
      options.drawingPerSession,
    ),
    drawingPerRoom: rateRule(
      "drawingPerRoom",
      DEFAULT_RESOURCE_LIMITS.drawingPerRoom,
      options.drawingPerRoom,
    ),
    submissionsPerSession: rateRule(
      "submissionsPerSession",
      DEFAULT_RESOURCE_LIMITS.submissionsPerSession,
      options.submissionsPerSession,
    ),
    submissionsPerRoom: rateRule(
      "submissionsPerRoom",
      DEFAULT_RESOURCE_LIMITS.submissionsPerRoom,
      options.submissionsPerRoom,
    ),
    reactionsPerSession: rateRule(
      "reactionsPerSession",
      DEFAULT_RESOURCE_LIMITS.reactionsPerSession,
      options.reactionsPerSession,
    ),
    roomCreatesPerConnection: rateRule(
      "roomCreatesPerConnection",
      DEFAULT_RESOURCE_LIMITS.roomCreatesPerConnection,
      options.roomCreatesPerConnection,
    ),
    roomCodeGuessesPerConnection: rateRule(
      "roomCodeGuessesPerConnection",
      DEFAULT_RESOURCE_LIMITS.roomCodeGuessesPerConnection,
      options.roomCodeGuessesPerConnection,
    ),
    roomCodeGuessesPerCode: rateRule(
      "roomCodeGuessesPerCode",
      DEFAULT_RESOURCE_LIMITS.roomCodeGuessesPerCode,
      options.roomCodeGuessesPerCode,
    ),
  };
}

function optionalEnvironmentInteger(
  environment: NodeJS.ProcessEnv,
  name: string,
): number | undefined {
  const raw = environment[name];
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) throw new RangeError(`${name} must be a positive integer.`);
  return positiveInteger(Number(raw), name);
}

export function resourceLimitOptionsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): ResourceLimitOptions {
  const rate = (maxName: string, windowName: string): Partial<RateLimitRule> | undefined => {
    const max = optionalEnvironmentInteger(environment, maxName);
    const windowMs = optionalEnvironmentInteger(environment, windowName);
    return max === undefined && windowMs === undefined ? undefined : { max, windowMs };
  };
  return {
    maxInboundMessageBytes: optionalEnvironmentInteger(environment, "MAX_INBOUND_MESSAGE_BYTES"),
    maxCanvasActionsPerRoom: optionalEnvironmentInteger(environment, "MAX_CANVAS_ACTIONS_PER_ROOM"),
    roomCleanupIntervalMs: optionalEnvironmentInteger(environment, "ROOM_CLEANUP_INTERVAL_MS"),
    drawingPerSession: rate("DRAWING_SESSION_RATE_MAX", "DRAWING_SESSION_RATE_WINDOW_MS"),
    drawingPerRoom: rate("DRAWING_ROOM_RATE_MAX", "DRAWING_ROOM_RATE_WINDOW_MS"),
    submissionsPerSession: rate(
      "SUBMISSION_SESSION_RATE_MAX",
      "SUBMISSION_SESSION_RATE_WINDOW_MS",
    ),
    submissionsPerRoom: rate("SUBMISSION_ROOM_RATE_MAX", "SUBMISSION_ROOM_RATE_WINDOW_MS"),
    reactionsPerSession: rate("REACTION_SESSION_RATE_MAX", "REACTION_SESSION_RATE_WINDOW_MS"),
    roomCreatesPerConnection: rate(
      "ROOM_CREATE_RATE_MAX",
      "ROOM_CREATE_RATE_WINDOW_MS",
    ),
    roomCodeGuessesPerConnection: rate(
      "ROOM_CODE_GUESS_CONNECTION_RATE_MAX",
      "ROOM_CODE_GUESS_CONNECTION_RATE_WINDOW_MS",
    ),
    roomCodeGuessesPerCode: rate(
      "ROOM_CODE_GUESS_CODE_RATE_MAX",
      "ROOM_CODE_GUESS_CODE_RATE_WINDOW_MS",
    ),
  };
}

interface Counter {
  count: number;
  resetAt: number;
}

export class FixedWindowRateLimiter {
  private readonly counters = new Map<string, Counter>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxTrackedKeys = 50_000,
  ) {}

  consume(key: string, rule: RateLimitRule, label: string): void {
    const now = this.now();
    if (!Number.isFinite(now)) {
      throw new RoomServiceError("REQUEST_FAILED", "The rate-limit clock is unavailable.");
    }
    let counter = this.counters.get(key);
    if (!counter || now >= counter.resetAt) {
      this.purgeExpired(now);
      if (!this.counters.has(key) && this.counters.size >= this.maxTrackedKeys) {
        throw new RoomServiceError(
          "REQUEST_FAILED",
          "The service is busy; retry this request shortly.",
        );
      }
      counter = { count: 0, resetAt: now + rule.windowMs };
      this.counters.set(key, counter);
    }

    if (counter.count >= rule.max) {
      const retryAfterMs = Math.max(1, Math.ceil(counter.resetAt - now));
      throw new RoomServiceError(
        "REQUEST_FAILED",
        `Rate limit exceeded for ${label}; retry in ${retryAfterMs} ms.`,
      );
    }
    counter.count += 1;
  }

  private purgeExpired(now: number): void {
    for (const [key, counter] of this.counters) {
      if (now >= counter.resetAt) this.counters.delete(key);
    }
  }
}
