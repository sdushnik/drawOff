import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";

const blueprintPath = new URL("../render.yaml", import.meta.url);
const dockerfilePath = new URL("../Dockerfile", import.meta.url);

function environmentVariable(service, key) {
  return service.envVars.find((variable) => variable.key === key);
}

test("Render Blueprint keeps the free deployment single-instance and secret-free", async () => {
  const source = await readFile(blueprintPath, "utf8");
  const blueprint = parse(source);

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
  assert.match(
    service.dockerCommand,
    /^\/bin\/sh -c 'node dist\/database\/migrate\.js && exec node dist\/index\.js'$/,
  );
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
});
