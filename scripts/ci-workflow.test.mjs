import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";

const workflowPath = new URL("../.github/workflows/ci-cd.yml", import.meta.url);

test("CI/CD verifies changes and separates development from production deployment", async () => {
  const source = await readFile(workflowPath, "utf8");
  const workflow = parse(source);

  assert.deepEqual(workflow.on, {
    pull_request: null,
    push: { branches: ["main"] },
    workflow_dispatch: {
      inputs: {
        deploy_production: {
          description: "Deploy the selected main commit to production",
          required: true,
          default: false,
          type: "boolean",
        },
      },
    },
  });
  assert.deepEqual(workflow.permissions, { contents: "read" });

  const verifySteps = workflow.jobs.verify.steps;
  assert.deepEqual(
    verifySteps.filter(({ uses }) => uses).map(({ uses }) => uses),
    [
      "actions/checkout@v7",
      "actions/setup-node@v7",
      "actions/upload-artifact@v6",
    ],
  );
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

  const development = workflow.jobs["deploy-development"];
  assert.equal(development.needs, "verify");
  assert.equal(development.environment, "development");
  assert.match(development.if, /github\.event_name == 'push'/u);
  assert.match(development.if, /github\.ref == 'refs\/heads\/main'/u);
  assert.match(
    development.if,
    /vars\.DEVELOPMENT_RENDER_DEPLOY_ENABLED == 'true'/u,
  );
  assert.equal(development.concurrency.group, "render-development");
  assert.equal(development.concurrency["cancel-in-progress"], false);

  const production = workflow.jobs["deploy-production"];
  assert.equal(production.needs, "verify");
  assert.equal(production.environment, "production");
  assert.match(production.if, /github\.event_name == 'workflow_dispatch'/u);
  assert.match(production.if, /github\.ref == 'refs\/heads\/main'/u);
  assert.match(production.if, /inputs\.deploy_production == true/u);
  assert.equal(production.if.includes("github.event_name == 'push'"), false);
  assert.equal(production.concurrency.group, "render-production");
  assert.equal(production.concurrency["cancel-in-progress"], false);

  const expectedDeploymentEnvironment = {
    RENDER_API_KEY: "${{ secrets.DRAWOFF_RENDER_API_KEY }}",
    RENDER_COMMIT_SHA: "${{ github.sha }}",
    RENDER_DEPLOY_HOOK_URL:
      "${{ secrets.DRAWOFF_RENDER_DEPLOY_HOOK_URL }}",
    RENDER_HEALTH_URL: "${{ vars.DRAWOFF_RENDER_HEALTH_URL }}",
    RENDER_SERVICE_ID: "${{ secrets.DRAWOFF_RENDER_SERVICE_ID }}",
  };
  assert.deepEqual(development.env, expectedDeploymentEnvironment);
  assert.deepEqual(production.env, expectedDeploymentEnvironment);
  assert.equal(
    development.steps.at(-1).run,
    "node scripts/render-deploy.mjs",
  );
  assert.equal(production.steps.at(-1).run, "node scripts/render-deploy.mjs");
  assert.equal(source.includes("pull_request_target"), false);
  assert.equal(source.includes("secrets.RENDER_API_KEY"), false);
  assert.equal(source.includes("hook-secret"), false);
  assert.equal(source.includes("test-api-key"), false);
});
