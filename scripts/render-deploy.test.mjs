import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deployAndVerifyRender } from "./render-deploy.mjs";

const commitSha = "a".repeat(40);

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function deployment(status) {
  return { status, commit: { id: commitSha } };
}

function options(fetchImplementation) {
  return {
    apiKey: "test-api-key",
    commitSha,
    deployHookUrl: "https://api.render.com/deploy/srv-test?key=hook-secret",
    serviceId: "srv-test",
    fetchImplementation,
    wait: async () => undefined,
    log: { log() {} },
    deployPollIntervalMs: 0,
    healthIntervalMs: 0,
  };
}

describe("Render deployment verifier", () => {
  it("deploys the exact commit, waits for live, and verifies the exact health body", async () => {
    const calls = [];
    const responses = [
      jsonResponse({ deploy: { id: "dep-test" } }),
      jsonResponse(deployment("build_in_progress")),
      jsonResponse(deployment("live")),
      new Response('{"status":"ready"}', { status: 200 }),
    ];

    await deployAndVerifyRender(
      options(async (url, requestOptions) => {
        calls.push({ url: String(url), requestOptions });
        return responses.shift();
      }),
    );

    const hook = new URL(calls[0].url);
    assert.equal(hook.searchParams.get("key"), "hook-secret");
    assert.equal(hook.searchParams.get("ref"), commitSha);
    assert.equal(calls[0].requestOptions.method, "POST");
    assert.equal(
      calls[1].requestOptions.headers.authorization,
      "Bearer test-api-key",
    );
    assert.equal(calls.at(-1).url, "https://drawoff.onrender.com/health");
    assert.equal(responses.length, 0);
  });

  it("fails without checking health when Render reports a terminal failure", async () => {
    const urls = [];
    await assert.rejects(
      deployAndVerifyRender(
        options(async (url) => {
          urls.push(String(url));
          return urls.length === 1
            ? jsonResponse({ deploy: { id: "dep-test" } })
            : jsonResponse(deployment("build_failed"));
        }),
      ),
      /ended with status build_failed/u,
    );
    assert.equal(urls.includes("https://drawoff.onrender.com/health"), false);
  });
});
