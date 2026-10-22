import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { Markovian } from "../vendor/meterless-markovian/src/index.js";
import { testConfig, withDesk } from "./helpers.js";

test("the investigation loop stops at the Meterless chunk limit and records the status", async () => {
  const config = testConfig({ execution: { maxChunks: 2, batchSize: 1 } });
  await withDesk(config, async (desk) => {
    const progress: string[] = [];
    desk.on("progress", (state) => progress.push(state.phase));
    const first = await desk.run();
    assert.equal(first.execution.status, "max-chunks");
    assert.equal(first.execution.chunks.length, 2);
    assert.equal(first.execution.chunkConfig.maxChunks, 2);
    assert.deepEqual(first.assessed.map((item) => item.record.id), ["EV-OMS-001", "EV-WMS-002"]);
    assert.deepEqual(first.unprocessed, ["EV-CAR-003", "EV-SUP-004"]);
    assert.ok(first.notes.some((note) => /not assessed in this run \(max-chunks\)/.test(note)));
    // The second chunk received the first chunk's state through Meterless carryover.
    assert.match(first.execution.chunks[1]!.carryover, /COMPLETED: assessed EV-OMS-001/);
    assert.match(first.execution.chunks[1]!.carryover, /REMAINING: EV-WMS-002, EV-CAR-003, EV-SUP-004/);
    assert.ok(progress.includes("generating") && progress.includes("compressing"), "Meterless progress events reach the desk");

    const second = await desk.run();
    assert.equal(second.execution.status, "completed");
    assert.deepEqual(second.assessed.map((item) => item.record.id), ["EV-CAR-003", "EV-SUP-004"]);
    assert.deepEqual(second.unprocessed, []);
    // Status is recorded both in Speck (run snapshots) and in Meterless run history.
    assert.deepEqual(desk.runs().map((run) => run.execution.status), ["max-chunks", "completed"]);
    const history = JSON.parse(fs.readFileSync(path.join(config.historyDir, "history.json"), "utf8")) as Array<{ status: string; chunkConfig: { maxChunks: number } }>;
    assert.deepEqual(history.map((run) => run.status), ["max-chunks", "completed"]);
    assert.ok(history.every((run) => run.chunkConfig.maxChunks === 2));
  });
});

test("a generator failure is recorded as an errored run, keeping evidence already assessed", async () => {
  let calls = 0;
  const failing = {
    kind: "rules" as const,
    describe: () => ({ kind: "rules" as const, label: "failing test reasoner", provider: "test", model: null, endpoint: null, ready: true, problem: null }),
    assess: async (input: { batch: Array<{ id: string }> }) => {
      calls += 1;
      if (calls === 2) throw new Error("model endpoint returned HTTP 503");
      return { judgments: Object.fromEntries(input.batch.map((record) => [record.id, []])), notes: [], narrative: "assessed" };
    },
    usage: () => null
  };
  await withDesk(testConfig(), async (desk) => {
    const run = await desk.run();
    assert.equal(run.execution.status, "errored");
    assert.match(run.execution.error ?? "", /HTTP 503/);
    assert.deepEqual(run.assessed.map((item) => item.record.id), ["EV-OMS-001", "EV-WMS-002"]);
    assert.deepEqual(run.unprocessed, ["EV-CAR-003", "EV-SUP-004"]);
    assert.equal(desk.runs()[0]!.execution.status, "errored");
  }, { reasoner: failing });
});

test("the vendored engine is the unmodified Meterless reference", () => {
  const notice = fs.readFileSync(path.resolve("vendor/meterless-markovian/NOTICE.md"), "utf8");
  assert.match(notice, /1742dec56a66e58eef9dda2d2b865823758ca8cd/);
  assert.match(fs.readFileSync(path.resolve("vendor/meterless-markovian/LICENSE"), "utf8"), /Apache License/);
  const engine = new Markovian({ chunkConfig: { maxChunks: 3, chunkSize: 4000, carryoverTokens: 512 } });
  assert.equal(engine.config.maxChunks, 3);
  assert.throws(() => new Markovian({ chunkConfig: { maxChunks: 99 } }), /maxChunks=99 outside/);
});
