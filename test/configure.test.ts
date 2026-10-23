import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEnv } from "node:util";
import { updateEnvText } from "../src/config.js";

test("npm run configure sets keys in .env in place, keeps comments, and quotes values Node would misread", () => {
  const before = "# Evidence source\r\nEVIDENCE_MODE=fixture\r\n# MODEL_PROVIDER=ollama\r\nREASONER=rules\r\nOTHER=kept\r\n";
  const after = updateEnvText(before, { REASONER: "nemotron", MODEL_PROVIDER: "meterless", ZETARIS_PASSWORD: "a b#c", meterless_runtime_token: "tok" });
  assert.equal(after, "# Evidence source\nEVIDENCE_MODE=fixture\n# MODEL_PROVIDER=ollama\nREASONER=nemotron\nOTHER=kept\nMODEL_PROVIDER=meterless\nZETARIS_PASSWORD='a b#c'\nmeterless_runtime_token=tok\n");
  assert.deepEqual(parseEnv(after), { EVIDENCE_MODE: "fixture", REASONER: "nemotron", OTHER: "kept", MODEL_PROVIDER: "meterless", ZETARIS_PASSWORD: "a b#c", meterless_runtime_token: "tok" });
});
