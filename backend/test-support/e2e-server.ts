import { createServer } from "../src/server.js";

const host = "127.0.0.1";
const port = 3100;
const frontendOrigin = "http://127.0.0.1:4173";

const { app } = createServer({
  corsOrigins: [frontendOrigin],
  logger: false,
  matchStateMachineOptions: {
    random: () => 0,
    phaseDurationsMs: {
      ROLE_REVEAL: 500,
      WORD_SELECTION: 5_000,
      DRAWING: 2_500,
      ROUND_RESULT: 700,
      JUDGE_MINIMUM: 8_000,
      JUDGE_PER_ARTIST: 1_000,
    },
    reconnectWindowMs: 1_200,
  },
});

await app.listen({ host, port });
console.log(`DrawOff E2E backend listening at http://${host}:${port}`);

const close = async () => {
  await app.close();
  process.exit(0);
};

process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
