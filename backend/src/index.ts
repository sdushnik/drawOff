import { startServer } from "./server.js";

const port = Number(process.env["PORT"] ?? 3000);
const host = process.env["HOST"] ?? "0.0.0.0";

try {
  const { address } = await startServer({ host, port });
  console.log(`DrawOff backend listening at ${address}`);
} catch (error) {
  console.error("Failed to start DrawOff backend:", error);
  process.exitCode = 1;
}
