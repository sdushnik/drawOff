import { DatabaseConfigurationError } from "./database/repository.js";

export function sanitizedStartupErrorMessage(error: unknown): string {
  if (error instanceof DatabaseConfigurationError) {
    return `Failed to start DrawOff backend: ${error.message}`;
  }
  return "Failed to start DrawOff backend: server initialization failed.";
}
