import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";

const productionBlueprintPath = new URL("../render.yaml", import.meta.url);
const developmentBlueprintPath = new URL(
  "../render-development.yaml",
  import.meta.url,
);
const dockerfilePath = new URL("../Dockerfile", import.meta.url);
const backendPackagePath = new URL("../backend/package.json", import.meta.url);

function environmentVariable(service, key) {
  return service.envVars.find((variable) => variable.key === key);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function readBlueprint(path) {
  const source = await readFile(path, "utf8");
  const blueprint = parse(source);

  return { blueprint, source };
}

async function assertFreeSecretlessBlueprint({ blueprint, source }) {
  assert.equal(blueprint.version, "1");
  assert.equal(blueprint.services.length, 1);
  assert.equal(blueprint.databases.length, 1);

  const [service] = blueprint.services;
  assert.deepEqual(
    {
      type: service.type,
      runtime: service.runtime,
      plan: service.plan,
      numInstances: service.numInstances,
      autoDeployTrigger: service.autoDeployTrigger,
      dockerfilePath: service.dockerfilePath,
      dockerContext: service.dockerContext,
      healthCheckPath: service.healthCheckPath,
    },
    {
      type: "web",
      runtime: "docker",
      plan: "free",
      numInstances: 1,
      autoDeployTrigger: "off",
      dockerfilePath: "./Dockerfile",
      dockerContext: ".",
      healthCheckPath: "/health",
    },
  );
  assert.equal("scaling" in service, false);
  assert.equal("preDeployCommand" in service, false);
  assert.equal(service.dockerCommand, "node dist/render.js");
  await readFile(dockerfilePath, "utf8");

  assert.deepEqual(environmentVariable(service, "DATABASE_URL"), {
    key: "DATABASE_URL",
    fromDatabase: {
      name: blueprint.databases[0].name,
      property: "connectionString",
    },
  });
  assert.deepEqual(environmentVariable(service, "FRONTEND_ORIGINS"), {
    key: "FRONTEND_ORIGINS",
    fromService: {
      name: service.name,
      type: "web",
      envVarKey: "RENDER_EXTERNAL_URL",
    },
  });
  assert.deepEqual(environmentVariable(service, "PORT"), {
    key: "PORT",
    value: "10000",
  });
  assert.equal(service.envVars.some(({ key }) => key.startsWith("VITE_")), false);

  assert.deepEqual(
    {
      plan: blueprint.databases[0].plan,
      postgresMajorVersion: blueprint.databases[0].postgresMajorVersion,
    },
    { plan: "free", postgresMajorVersion: "18" },
  );
  assert.equal(source.includes("postgresql://"), false);
}

test("production Render Blueprint remains free, single-instance, and secret-free", async () => {
  const result = await readBlueprint(productionBlueprintPath);

  await assertFreeSecretlessBlueprint(result);
  assert.equal(result.blueprint.services[0].name, "drawoff");
  assert.equal(result.blueprint.databases[0].name, "drawoff-postgres");
  assert.equal(result.blueprint.databases[0].databaseName, "drawoff");
  assert.deepEqual(
    environmentVariable(
      result.blueprint.services[0],
      "DRAWOFF_DEPLOYMENT_ENVIRONMENT",
    ),
    { key: "DRAWOFF_DEPLOYMENT_ENVIRONMENT", value: "production" },
  );
  assert.deepEqual(
    environmentVariable(result.blueprint.services[0], "OTEL_SERVICE_NAME"),
    { key: "OTEL_SERVICE_NAME", value: "drawoff-backend" },
  );
});

test("development Render Blueprint has independent free resources and database state", async () => {
  const production = await readBlueprint(productionBlueprintPath);
  const development = await readBlueprint(developmentBlueprintPath);

  await assertFreeSecretlessBlueprint(development);
  assert.equal(development.blueprint.services[0].name, "drawoff-development");
  assert.equal(
    development.blueprint.databases[0].name,
    "drawoff-development-postgres",
  );
  assert.equal(
    development.blueprint.databases[0].databaseName,
    "drawoff_development",
  );
  assert.notEqual(
    development.blueprint.services[0].name,
    production.blueprint.services[0].name,
  );
  assert.notEqual(
    development.blueprint.databases[0].name,
    production.blueprint.databases[0].name,
  );
  assert.notEqual(
    development.blueprint.databases[0].databaseName,
    production.blueprint.databases[0].databaseName,
  );
  assert.deepEqual(
    environmentVariable(
      development.blueprint.services[0],
      "DRAWOFF_DEPLOYMENT_ENVIRONMENT",
    ),
    { key: "DRAWOFF_DEPLOYMENT_ENVIRONMENT", value: "development" },
  );
  assert.deepEqual(
    environmentVariable(
      development.blueprint.services[0],
      "OTEL_SERVICE_NAME",
    ),
    { key: "OTEL_SERVICE_NAME", value: "drawoff-backend" },
  );
});

test("production image bundles every external backend runtime dependency", async () => {
  const dockerfile = await readFile(dockerfilePath, "utf8");
  const backendPackage = JSON.parse(await readFile(backendPackagePath, "utf8"));
  const externalDependencies = Object.keys(backendPackage.dependencies).filter(
    (dependency) => dependency !== "@drawoff/contracts",
  );

  for (const dependency of externalDependencies) {
    assert.match(
      dockerfile,
      new RegExp(
        `bundledDependencies\\[\\d+\\]=${escapeRegExp(dependency)}`,
        "u",
      ),
      `${dependency} must be bundled into the production backend package`,
    );
  }
});
