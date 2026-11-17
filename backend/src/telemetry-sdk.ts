import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";

export interface TelemetryConfiguration {
  enabled: boolean;
  serviceName: string;
  environment: string;
  version: string;
}

export interface TelemetryRuntime {
  configuration: TelemetryConfiguration;
  shutdown(): Promise<void>;
}

function safeResourceValue(value: string | undefined, fallback: string): string {
  const candidate = value?.trim();
  if (!candidate || candidate.length > 128) return fallback;
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(candidate) ? candidate : fallback;
}

export function telemetryConfigurationFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): TelemetryConfiguration {
  return {
    enabled: environment["DRAWOFF_TELEMETRY_ENABLED"] === "true",
    serviceName: safeResourceValue(
      environment["OTEL_SERVICE_NAME"],
      "drawoff-backend",
    ),
    environment: safeResourceValue(
      environment["DRAWOFF_DEPLOYMENT_ENVIRONMENT"] ?? environment["NODE_ENV"],
      "development",
    ),
    version: safeResourceValue(
      environment["DRAWOFF_SERVICE_VERSION"] ?? environment["RENDER_GIT_COMMIT"],
      "development",
    ),
  };
}

export function telemetryResourceAttributes(
  configuration: TelemetryConfiguration,
): Record<string, string> {
  return {
    "service.name": configuration.serviceName,
    "service.version": configuration.version,
    "deployment.environment.name": configuration.environment,
  };
}

export function initializeTelemetry(
  environment: NodeJS.ProcessEnv = process.env,
): TelemetryRuntime {
  const configuration = telemetryConfigurationFromEnvironment(environment);
  if (!configuration.enabled) {
    return { configuration, shutdown: async () => undefined };
  }

  const resource = resourceFromAttributes(
    telemetryResourceAttributes(configuration),
  );
  const sdk = new NodeSDK({
    autoDetectResources: false,
    resource,
    traceExporter: new OTLPTraceExporter(),
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
      }),
    ],
    logRecordProcessors: [
      new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() }),
    ],
  });
  sdk.start();

  return {
    configuration,
    shutdown: async () => sdk.shutdown(),
  };
}
