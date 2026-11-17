import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const renderApiOrigin = "https://api.render.com";
const activeStatuses = new Set([
  "created",
  "queued",
  "build_in_progress",
  "pre_deploy_in_progress",
  "update_in_progress",
]);

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function safeFetch(fetchImplementation, url, options, description) {
  try {
    return await fetchImplementation(url, options);
  } catch {
    throw new Error(`${description} failed before receiving a response.`);
  }
}

async function readJson(response, description) {
  try {
    return await response.json();
  } catch {
    throw new Error(`${description} returned invalid JSON.`);
  }
}

function apiHeaders(apiKey) {
  return {
    accept: "application/json",
    authorization: `Bearer ${apiKey}`,
  };
}

async function findQueuedDeploy({
  apiKey,
  commitSha,
  fetchImplementation,
  serviceId,
  wait,
  attempts,
  intervalMs,
}) {
  const deploysUrl = `${renderApiOrigin}/v1/services/${encodeURIComponent(serviceId)}/deploys?limit=20`;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await safeFetch(
      fetchImplementation,
      deploysUrl,
      { headers: apiHeaders(apiKey), signal: AbortSignal.timeout(30_000) },
      "Render deploy lookup",
    );
    if (!response.ok)
      throw new Error(`Render deploy lookup returned HTTP ${response.status}.`);
    const entries = await readJson(response, "Render deploy lookup");
    const match = Array.isArray(entries)
      ? entries.find(
          (entry) =>
            entry?.deploy?.commit?.id === commitSha &&
            entry.deploy.trigger === "deploy_hook",
        )
      : undefined;
    if (typeof match?.deploy?.id === "string") return match.deploy.id;
    if (attempt < attempts) await wait(intervalMs);
  }
  throw new Error(
    "Render accepted the deploy but its deployment record was not found.",
  );
}

export async function deployAndVerifyRender({
  apiKey,
  commitSha,
  deployHookUrl,
  serviceId,
  fetchImplementation = fetch,
  wait = delay,
  log = console,
  deployPollAttempts = 120,
  deployPollIntervalMs = 15_000,
  queuedLookupAttempts = 20,
  queuedLookupIntervalMs = 5_000,
  healthAttempts = 12,
  healthIntervalMs = 10_000,
  healthUrl,
}) {
  if (!/^[0-9a-f]{40}$/u.test(commitSha))
    throw new Error(
      "RENDER_COMMIT_SHA must be a full lowercase Git commit SHA.",
    );

  let hookUrl;
  try {
    hookUrl = new URL(deployHookUrl);
  } catch {
    throw new Error("RENDER_DEPLOY_HOOK_URL must be a valid URL.");
  }
  if (hookUrl.protocol !== "https:")
    throw new Error("RENDER_DEPLOY_HOOK_URL must use HTTPS.");
  hookUrl.searchParams.set("ref", commitSha);

  let parsedHealthUrl;
  try {
    parsedHealthUrl = new URL(healthUrl);
  } catch {
    throw new Error("RENDER_HEALTH_URL must be a valid URL.");
  }
  if (parsedHealthUrl.protocol !== "https:")
    throw new Error("RENDER_HEALTH_URL must use HTTPS.");
  if (parsedHealthUrl.username || parsedHealthUrl.password)
    throw new Error("RENDER_HEALTH_URL must not contain credentials.");

  const triggerResponse = await safeFetch(
    fetchImplementation,
    hookUrl,
    {
      method: "POST",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    },
    "Render deploy hook request",
  );
  if (triggerResponse.status !== 200 && triggerResponse.status !== 202) {
    throw new Error(
      `Render deploy hook request returned HTTP ${triggerResponse.status}.`,
    );
  }

  let deployId;
  if (triggerResponse.status === 200) {
    const triggerBody = await readJson(
      triggerResponse,
      "Render deploy hook request",
    );
    deployId = triggerBody?.deploy?.id;
    if (typeof deployId !== "string")
      throw new Error(
        "Render deploy hook response did not include a deployment ID.",
      );
  } else {
    deployId = await findQueuedDeploy({
      apiKey,
      commitSha,
      fetchImplementation,
      serviceId,
      wait,
      attempts: queuedLookupAttempts,
      intervalMs: queuedLookupIntervalMs,
    });
  }

  const deployUrl = `${renderApiOrigin}/v1/services/${encodeURIComponent(serviceId)}/deploys/${encodeURIComponent(deployId)}`;
  let previousStatus;
  for (let attempt = 1; attempt <= deployPollAttempts; attempt += 1) {
    const response = await safeFetch(
      fetchImplementation,
      deployUrl,
      { headers: apiHeaders(apiKey), signal: AbortSignal.timeout(30_000) },
      "Render deployment status request",
    );
    if (!response.ok)
      throw new Error(
        `Render deployment status request returned HTTP ${response.status}.`,
      );
    const deploy = await readJson(response, "Render deployment status request");
    if (deploy?.commit?.id !== commitSha)
      throw new Error("Render deployment does not match the verified commit.");
    if (deploy.status !== previousStatus) {
      log.log(`Render deployment status: ${deploy.status}.`);
      previousStatus = deploy.status;
    }
    if (deploy.status === "live") break;
    if (!activeStatuses.has(deploy.status))
      throw new Error(`Render deployment ended with status ${deploy.status}.`);
    if (attempt === deployPollAttempts)
      throw new Error(
        "Timed out waiting for the Render deployment to become live.",
      );
    await wait(deployPollIntervalMs);
  }

  for (let attempt = 1; attempt <= healthAttempts; attempt += 1) {
    const response = await safeFetch(
      fetchImplementation,
      parsedHealthUrl,
      {
        headers: { "cache-control": "no-cache" },
        signal: AbortSignal.timeout(30_000),
      },
      "Render health check",
    );
    const body = await response.text();
    if (response.status === 200 && body === '{"status":"ready"}') {
      log.log("Verified Render health endpoint.");
      return;
    }
    if (attempt === healthAttempts)
      throw new Error(
        "Render health endpoint did not return the ready response.",
      );
    await wait(healthIntervalMs);
  }
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value)
    throw new Error(`${name} is required when Render deployment is enabled.`);
  return value;
}

async function main() {
  await deployAndVerifyRender({
    apiKey: requiredEnvironment("RENDER_API_KEY"),
    commitSha: requiredEnvironment("RENDER_COMMIT_SHA"),
    deployHookUrl: requiredEnvironment("RENDER_DEPLOY_HOOK_URL"),
    healthUrl: requiredEnvironment("RENDER_HEALTH_URL"),
    serviceId: requiredEnvironment("RENDER_SERVICE_ID"),
  });
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  await main();
}
