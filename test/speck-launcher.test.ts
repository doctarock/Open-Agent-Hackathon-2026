import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { test } from "node:test";
import { EVIDENCE_HOME_VIEW, shouldOpenBrowser, speckAddress, speckEnv, stopRunningSpeck } from "../src/scripts/speck.js";

// A stand-in Speck in its own process: it answers /api/brains/config as Speck
// does, and prints its port once listening.
function standInSpeck(): Promise<{ port: number; exited: Promise<unknown> }> {
  const source = `require("node:http").createServer((q, r) => { r.writeHead(200, { "content-type": "application/json" }); r.end(JSON.stringify(q.url === "/api/brains/config" ? { ok: true, brains: { processors: [] } } : { ok: true })); })
    .listen(0, "127.0.0.1", function () { console.log(this.address().port); });`;
  const child = spawn(process.execPath, ["-e", source], { stdio: ["ignore", "pipe", "inherit"] });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  return new Promise((resolve, reject) => {
    child.stdout.once("data", (chunk) => resolve({ port: Number(String(chunk).trim()), exited }));
    child.once("error", reject);
  });
}

test("the launcher reads Speck's address as Speck does", () => {
  assert.deepEqual(speckAddress({}), { host: "127.0.0.1", port: 4310 });
  assert.deepEqual(speckAddress({ SPECK_PORT: "4400", SPECK_HOST: "0.0.0.0" }), { host: "127.0.0.1", port: 4400 });
  assert.deepEqual(speckAddress({ PORT: "4401" }), { host: "127.0.0.1", port: 4401 });
});

test("Speck gets the Meterless token from .env, and nothing else from it", () => {
  const dotEnv = "ZETARIS_PASSWORD=secret\nmeterless_runtime_token=tok-123\n";
  const env = speckEnv({ PATH: "p" }, dotEnv);
  assert.deepEqual(env, { PATH: "p", meterless_runtime_token: "tok-123", SPECK_HOME_VIEW: EVIDENCE_HOME_VIEW });
  assert.equal(speckEnv({ meterless_runtime_token: "from-env" }, dotEnv).meterless_runtime_token, "from-env", "the environment wins");
  assert.equal(speckEnv({}, null).meterless_runtime_token, undefined, "no .env, no token");
  assert.equal(speckEnv({ SPECK_HOME_VIEW: "world" }, "").SPECK_HOME_VIEW, "world");
});

test("the launcher opens a browser unless SPECK_OPEN_BROWSER turns it off", () => {
  assert.equal(shouldOpenBrowser({}), true);
  assert.equal(shouldOpenBrowser({ SPECK_OPEN_BROWSER: "1" }), true);
  for (const off of ["0", "false", "No", " off "]) assert.equal(shouldOpenBrowser({ SPECK_OPEN_BROWSER: off }), false, off);
});

test("a Speck already running on the port is stopped, and the port is freed", async () => {
  const { port, exited } = await standInSpeck();
  const lines: string[] = [];
  await stopRunningSpeck("127.0.0.1", port, (line) => lines.push(line));
  await exited;
  assert.match(lines.join("\n"), /already running .* stopping it/);
  await stopRunningSpeck("127.0.0.1", port, (line) => lines.push(line));
  assert.equal(lines.length, 1, "a free port needs nothing stopped");
});

test("something on the port that is not Speck is left running, and nothing starts", async () => {
  const server = http.createServer((_request, response) => { response.end(JSON.stringify({ ok: true })); }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as { port: number };
  try {
    await assert.rejects(stopRunningSpeck("127.0.0.1", port, () => {}), /not Speck/);
    assert.equal(server.listening, true);
  } finally {
    server.close();
  }
});
