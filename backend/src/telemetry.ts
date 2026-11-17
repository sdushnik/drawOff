import {
  SeverityNumber,
  SpanKind,
  SpanStatusCode,
  context,
  logs,
  metrics,
  trace,
  type Attributes,
  type Context,
  type Counter,
  type Histogram,
  type Logger,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import type { ClientToServerPayloads } from "@drawoff/contracts";

export type DatabaseTelemetryOperation = "migrate" | "load" | "replace" | "close";
export type SocketTelemetryEvent = keyof ClientToServerPayloads;
export type TelemetryOutcome = "ok" | "error";

export interface TelemetryOperation {
  run<T>(operation: () => T): T;
  end(outcome: TelemetryOutcome): void;
}

export interface BackendTelemetry {
  startHttpRequest(
    method: string,
    route: string | undefined,
  ): TelemetryOperation;
  startSocketEvent(event: SocketTelemetryEvent): TelemetryOperation;
  startDatabaseOperation(
    operation: DatabaseTelemetryOperation,
  ): TelemetryOperation;
}

const instrumentationName = "@drawoff/backend";
const allowedHttpMethods = new Set([
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
]);

function safeHttpMethod(method: string): string {
  const normalized = method.toUpperCase();
  return allowedHttpMethods.has(normalized) ? normalized : "OTHER";
}

function safeHttpRoute(route: string | undefined): string {
  return route === "/health" ? "/health" : "unmatched";
}

class OpenTelemetryOperation implements TelemetryOperation {
  private ended = false;
  private readonly startedAt = performance.now();

  constructor(
    private readonly span: Span,
    private readonly operationContext: Context,
    private readonly attributes: Attributes,
    private readonly counter: Counter,
    private readonly duration: Histogram,
    private readonly logger: Logger,
  ) {}

  run<T>(operation: () => T): T {
    return context.with(this.operationContext, operation);
  }

  end(outcome: TelemetryOutcome): void {
    if (this.ended) return;
    this.ended = true;
    const durationMs = Math.max(0, performance.now() - this.startedAt);
    const finalAttributes = {
      ...this.attributes,
      "drawoff.operation.outcome": outcome,
    };
    this.span.setAttributes(finalAttributes);
    this.span.setStatus({
      code: outcome === "ok" ? SpanStatusCode.OK : SpanStatusCode.ERROR,
    });
    this.counter.add(1, finalAttributes, this.operationContext);
    this.duration.record(durationMs, finalAttributes, this.operationContext);
    this.logger.emit({
      body: "Backend operation completed.",
      severityNumber:
        outcome === "ok" ? SeverityNumber.INFO : SeverityNumber.ERROR,
      severityText: outcome === "ok" ? "INFO" : "ERROR",
      attributes: {
        ...finalAttributes,
        "drawoff.operation.duration_ms": durationMs,
      },
      context: this.operationContext,
    });
    this.span.end();
  }
}

export class OpenTelemetryBackendTelemetry implements BackendTelemetry {
  private instruments?: {
    tracer: Tracer;
    counter: Counter;
    duration: Histogram;
    logger: Logger;
  };

  private getInstruments() {
    if (this.instruments) return this.instruments;
    const meter = metrics.getMeter(instrumentationName);
    this.instruments = {
      tracer: trace.getTracer(instrumentationName),
      counter: meter.createCounter("drawoff.backend.operations", {
        description: "Completed DrawOff backend operations.",
      }),
      duration: meter.createHistogram("drawoff.backend.operation.duration", {
        description: "DrawOff backend operation duration.",
        unit: "ms",
      }),
      logger: logs.getLogger(instrumentationName),
    };
    return this.instruments;
  }

  private start(
    spanName: string,
    kind: SpanKind,
    attributes: Attributes,
  ): TelemetryOperation {
    const instruments = this.getInstruments();
    const span = instruments.tracer.startSpan(spanName, { kind, attributes });
    const operationContext = trace.setSpan(context.active(), span);
    return new OpenTelemetryOperation(
      span,
      operationContext,
      attributes,
      instruments.counter,
      instruments.duration,
      instruments.logger,
    );
  }

  startHttpRequest(
    method: string,
    route: string | undefined,
  ): TelemetryOperation {
    return this.start("http.request", SpanKind.SERVER, {
      "drawoff.operation.kind": "http",
      "drawoff.operation.name": "request",
      "http.request.method": safeHttpMethod(method),
      "http.route": safeHttpRoute(route),
    });
  }

  startSocketEvent(event: SocketTelemetryEvent): TelemetryOperation {
    return this.start(`socket.io.${event}`, SpanKind.SERVER, {
      "drawoff.operation.kind": "socket.io",
      "drawoff.operation.name": event,
      "messaging.system": "socket.io",
    });
  }

  startDatabaseOperation(
    operation: DatabaseTelemetryOperation,
  ): TelemetryOperation {
    return this.start(`database.${operation}`, SpanKind.CLIENT, {
      "drawoff.operation.kind": "database",
      "drawoff.operation.name": operation,
      "db.system.name": "kysely",
    });
  }
}

export const backendTelemetry: BackendTelemetry =
  new OpenTelemetryBackendTelemetry();

export async function runTelemetryOperation<T>(
  operation: TelemetryOperation,
  callback: () => Promise<T>,
): Promise<T> {
  try {
    const result = await operation.run(callback);
    operation.end("ok");
    return result;
  } catch (error) {
    operation.end("error");
    throw error;
  }
}
