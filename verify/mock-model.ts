import { startMockModel } from "../apps/server/src/features/agent/testing/mock-model-server.ts";
import { ModelStep } from "../apps/server/src/features/agent/testing/model-script.ts";

/**
The model for demos (`verify/compose.yml`): every call answers "Hi there, nice to meet you!" a word at
a time, slowly enough that a scenario sees the answer half written. A demo may send any number of
messages, so the one-step script loops. Start it with `node verify/mock-model.ts [port]`.
*/
const server = await startMockModel({
  script: [ModelStep.Say({ words: ["Hi", " there,", " nice", " to", " meet", " you!"] })],
  afterLastStep: "loop",
  delayMs: Number(process.env.MOCK_MODEL_DELAY_MS ?? 150),
  host: "0.0.0.0",
  port: Number(process.argv[2] ?? process.env.MOCK_MODEL_PORT ?? 4010),
});

console.log(`mock model listening on :${server.port}`);
