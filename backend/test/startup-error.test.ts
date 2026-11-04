import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseConfigurationError } from "../src/database/repository.js";
import { sanitizedStartupErrorMessage } from "../src/startup-error.js";

test("startup database failures expose no stack, URL, SQL, or driver details", () => {
  const configurationError = new DatabaseConfigurationError("DATABASE_URL must be configured.");
  configurationError.stack = "secret internal stack";
  assert.equal(
    sanitizedStartupErrorMessage(configurationError),
    "Failed to start DrawOff backend: DATABASE_URL must be configured.",
  );

  const internal = new Error("SQLITE_CANTOPEN /secret/path databaseUrl=secret");
  internal.stack = "secret internal stack";
  assert.equal(
    sanitizedStartupErrorMessage(internal),
    "Failed to start DrawOff backend: server initialization failed.",
  );
});
