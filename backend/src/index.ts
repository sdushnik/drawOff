import { startServer } from "./server.js";
import { sanitizedStartupErrorMessage } from "./startup-error.js";

const port = Number(process.env["PORT"] ?? 3000);
const host = process.env["HOST"] ?? "0.0.0.0";
const frontendAssetsDirectory = process.env["FRONTEND_ASSETS_DIR"];

try {
  const { address } = await startServer({ host, port, frontendAssetsDirectory });
  console.log(`DrawOff backend listening at ${address}`);
} catch (error) {
  console.error(sanitizedStartupErrorMessage(error));
  process.exitCode = 1;
}
