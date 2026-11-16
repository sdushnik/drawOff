import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";

const workflowPath = new URL("../.github/workflows/ci-cd.yml", import.meta.url);

test("CI/CD verifies pull requests and main pushes before an opt-in deployment", async () => {
  const source = await readFile(workflowPath, "utf8");
  const workflow = parse(source);

  assert.deepEqual(workflow.on, {
    pull_request: null,
    push: { branches: ["main"] },
  });
  assert.deepEqual(workflow.permissions, { contents: "read" });

  const verifySteps = workflow.jobs.verify.steps;
  const commands = verifySteps
    .map((step) => step.run)
    .filter((command) => typeof command === "string");
  assert.deepEqual(commands, [
    "npm ci",
    "npm test",
    "npm run build",
    'docker build --pull --tag "drawoff:${GITHUB_SHA}" .',
    "npm exec --workspace frontend -- playwright install --with-deps chromium",
    "npm run test:e2e:compose",
  ]);

  const artifactStep = verifySteps.find(
    (step) => step.name === "Upload Playwright failure artifacts",
  );
  assert.equal(artifactStep.if, "${{ failure() }}");
  assert.equal(artifactStep.with["if-no-files-found"], "ignore");
  assert.match(artifactStep.with.path, /frontend\/playwright-report\//u);
  assert.match(artifactStep.with.path, /frontend\/test-results\//u);

  const deploy = workflow.jobs.deploy;
  assert.equal(deploy.needs, "verify");
  assert.match(deploy.if, /github\.event_name == 'push'/u);
  assert.match(deploy.if, /github\.ref == 'refs\/heads\/main'/u);
  assert.match(deploy.if, /vars\.RENDER_DEPLOY_ENABLED == 'true'/u);
  assert.equal(deploy.concurrency["cancel-in-progress"], false);
  assert.deepEqual(deploy.env, {
    RENDER_API_KEY: "${{ secrets.RENDER_API_KEY }}",
    RENDER_COMMIT_SHA: "${{ github.sha }}",
    RENDER_DEPLOY_HOOK_URL: "${{ secrets.RENDER_DEPLOY_HOOK_URL }}",
    RENDER_SERVICE_ID: "${{ secrets.RENDER_SERVICE_ID }}",
  });
  assert.equal(deploy.steps.at(-1).run, "node scripts/render-deploy.mjs");
  assert.equal(source.includes("pull_request_target"), false);
  assert.equal(source.includes("hook-secret"), false);
  assert.equal(source.includes("test-api-key"), false);
});
