import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ROOT_DIR } from "../src/config.js";
import { caseFolder, investigate, sampleConfig, type TraceLine } from "../src/scripts/investigate.js";
import { tempDir } from "./helpers.js";

// The reference examples in examples/: each input, run in sample mode, gives
// exactly its expected output. The expected outputs are only compared here;
// nothing reads them to produce a result.

const EXAMPLES_DIR = path.join(ROOT_DIR, "examples");
const examples = fs.readdirSync(EXAMPLES_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);

test("there are three examples, each an input and its expected output", () => {
  assert.equal(examples.length, 3);
  for (const name of examples) {
    assert.ok(fs.existsSync(path.join(EXAMPLES_DIR, name, "input.json")), `${name}/input.json`);
    assert.ok(fs.existsSync(path.join(EXAMPLES_DIR, name, "expected-output.json")), `${name}/expected-output.json`);
  }
});

for (const name of examples) {
  test(`example ${name}: sample mode reproduces the expected output`, async () => {
    const scratch = tempDir();
    const lines: TraceLine[] = [];
    const result = await investigate(caseFolder(path.join(EXAMPLES_DIR, name, "input.json"), scratch), sampleConfig(scratch), (line) => lines.push(line));
    assert.deepEqual(result, JSON.parse(fs.readFileSync(path.join(EXAMPLES_DIR, name, "expected-output.json"), "utf8")));
    // The trace shows each run's evidence fetch, the engine's chunks and the assessor.
    const runs = lines.filter((line) => line.step === "run");
    assert.equal(runs.length, result.stages.length);
    for (const run of runs) {
      assert.equal((run.evidence as { mode: string }).mode, "fixture");
      assert.equal((run.engine as { status: string }).status, "completed");
      assert.equal((run.reasoner as { kind: string }).kind, "rules");
    }
    assert.ok(lines.some((line) => line.step === "chunk"));
  });
}

test("the CLI runs with no .env or credentials and writes the same lines to stdout and logs/", () => {
  const logs = tempDir();
  const output = path.join(tempDir(), "result.json");
  const name = examples[0]!;
  // Only what Node needs to start; no setting of Evidence Desk's.
  const env = { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" };
  const child = spawnSync(process.execPath, [path.join(ROOT_DIR, "dist", "src", "scripts", "investigate.js"), path.join(EXAMPLES_DIR, name, "input.json"), "--logs", logs, "--output", output], { env, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const stdout = child.stdout.trim().split("\n").map((line) => JSON.parse(line) as TraceLine);
  assert.deepEqual(stdout.map((line) => line.type).filter((type, index, all) => all.indexOf(type) === index), ["start", "stage", "trace", "result"]);
  const [logFile] = fs.readdirSync(logs);
  assert.equal(fs.readFileSync(path.join(logs, logFile!), "utf8"), child.stdout);
  assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), JSON.parse(fs.readFileSync(path.join(EXAMPLES_DIR, name, "expected-output.json"), "utf8")));
});
