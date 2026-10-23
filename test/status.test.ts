import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { ROOT_DIR } from "../src/config.js";
import { deskApi } from "../src/investigation/api.js";
import type { EvidenceDesk } from "../src/investigation/desk.js";
import { ruleJudgments } from "../src/reasoning/rules.js";
import type { Reasoner } from "../src/reasoning/types.js";
import { testConfig, withDesk } from "./helpers.js";

// Run outcomes and failures as the page states them (public/status.js),
// from real API payloads wherever the state can be produced.

const status = await import(pathToFileURL(path.join(ROOT_DIR, "public", "status.js")).href) as any;
const tour = await import(pathToFileURL(path.join(ROOT_DIR, "public", "tour.js")).href) as any;
const json = (value: unknown) => JSON.parse(JSON.stringify(value));
const view = async (api: ReturnType<typeof deskApi>) => ({ status: json(api.status()), investigation: json(api.investigation()), listing: json(await api.evidence()), trace: json(api.trace()) });

test("a completed run states its conclusion and the next step; a leading or supported result is not a warning", async () => {
  const config = testConfig();
  await withDesk(config, async (desk) => {
    const api = deskApi(desk, config, "test");
    await desk.run();
    const first = status.describeRun(await view(api));
    assert.equal(first.tone, "ok");
    assert.equal(first.title, "Run 1 completed.");
    assert.match(first.lines.join(" "), /Speck's conclusion now: Leading, not established/);
    assert.match(first.next, /introduce the prepared update \("Carrier proof-of-delivery review/);
    await desk.introduceNextUpdate();
    await desk.run();
    const second = status.describeRun(await view(api));
    assert.deepEqual([second.tone, second.title], ["ok", "Run 2 completed."]);
    assert.match(second.next, /Every prepared update is in/);
  });
});

test("a failed assessment is a stopped run with records pending to retry, not a failed investigation", async () => {
  let current: EvidenceDesk | null = null;
  const failing: Reasoner = {
    kind: "rules",
    describe: () => ({ kind: "rules", label: "test", provider: "none", model: null, endpoint: null, ready: true, problem: null }),
    usage: () => null,
    async assess(input) {
      if (input.batch.some((record) => record.id === "EV-CAR-003")) throw new Error("model output unparseable\n    at parse (nemotron.ts:12:3)");
      return { judgments: Object.fromEntries(input.batch.map((record) => [record.id, ruleJudgments(record, current!.scenario.hypotheses)])), notes: [], narrative: "" };
    }
  };
  const config = testConfig();
  await withDesk(config, async (desk) => {
    current = desk;
    await desk.run();
    const outcome = status.describeRun(await view(deskApi(desk, config, "test")));
    assert.equal(outcome.tone, "warn");
    assert.equal(outcome.title, "Run 1 stopped early: an assessment failed.");
    const text = outcome.lines.join(" ");
    assert.match(text, /EV-CAR-003, EV-SUP-004 stay pending; nothing was guessed/);
    assert.doesNotMatch(text, /nemotron\.ts:12/, "no stack frames");
    assert.match(outcome.next, /Run the investigation again/);
  }, { reasoner: failing });
});

test("an unresolved conclusion is a result, and recovery is only called complete when beliefs are reconciled", () => {
  const base = {
    status: { nextStage: null, stages: [] },
    listing: { pending: [] },
    trace: { entries: [{ kind: "run", flags: { recovered: ["run-a"] } }] },
    investigation: { latestRun: { runNumber: 3, stage: { id: "s" }, execution: { status: "completed", chunkConfig: { maxChunks: 8 } } },
      current: { state: "unresolved", headline: "Unresolved: the assessed evidence does not establish any explanation.", reconciled: true } }
  };
  const done = status.describeRun(base);
  assert.equal(done.tone, "ok");
  assert.match(done.lines.join(" "), /unresolved: .* That is a result of the evidence so far, not a failure of the run\./);
  assert.match(done.lines.join(" "), /picked up 1 interrupted earlier run\(s\).*reconciled with its evidence ledger/);
  const lagging = status.describeRun({ ...base, investigation: { ...base.investigation, current: { ...base.investigation.current, reconciled: false } } });
  assert.equal(lagging.tone, "warn");
  assert.match(lagging.lines.join(" "), /Recovery is incomplete/);
  assert.doesNotMatch(lagging.lines.join(" "), /picked up/);
});

test("failed requests say what did not happen and what to do, without stack traces", () => {
  const busy = status.describeFailure("reset", { message: "An investigation run is already in progress", body: { kind: "busy" } });
  assert.deepEqual([busy.tone, busy.next], ["warn", "Wait for it to finish, then try again."]);
  const evidence = status.describeFailure("run", { message: "Zetaris is not reachable at http://localhost:3000", body: { kind: "evidence", mode: "zetaris", hint: "Start the platform." } });
  assert.equal(evidence.title, "The investigation did not run: the evidence could not be read (zetaris mode).");
  assert.ok(evidence.lines.includes("No run was recorded, and no fallback data was used."));
  const internal = status.describeFailure("reset", { message: "org.apache.hive.service.cli.HiveSQLException: boom\n\tat x.y(Z.java:1)\nSpeck refused the transition", body: { kind: "internal" } });
  assert.equal(internal.title, "The demo case was not reset: the server reported an error.");
  assert.deepEqual(internal.lines, ["Speck refused the transition"]);
  const long = status.plainMessage("x".repeat(400));
  assert.ok(long.length <= 240 && long.endsWith("…"));
  assert.match(status.describeProgress("run", 12_400, { phase: "chunk", phaseDetail: "assessing", currentChunk: 2, maxChunks: 8 }),
    /^Running the investigation… 12 s elapsed\. Execution engine: chunk \(assessing\), chunk 2 of at most 8\.$/);
  assert.equal(status.describeProgress("run", 3_000, null), "Running the investigation… 3 s elapsed.");
});

test("minimising the tour is remembered with its step, and a demo reset starts the next person from the introduction", () => {
  const map = new Map<string, string>();
  const storage = { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); } };
  const store = tour.progressStore(storage, "/api");
  store.dismissIntro(); store.setTourStep(4); store.setCoachCollapsed(true); store.markViewed("trace");
  const again = tour.progressStore(storage, "/api");
  assert.deepEqual([again.tourStep(), again.coachCollapsed()], [4, true]);
  again.resetForDemo();
  assert.deepEqual([again.introDismissed(), again.tourStep(), again.coachCollapsed(), again.viewed().size], [false, null, false, 0]);
});

test("for a person's own investigation the next step is to add evidence, not a prepared update", () => {
  const outcome = status.describeRun({
    status: { case: { scenarioId: "user-my-1" }, nextStage: null }, listing: { pending: [] }, trace: { entries: [] },
    investigation: { latestRun: { runNumber: 1, stage: { id: "entered" }, execution: { status: "completed" } }, current: { state: "leading", headline: "Leading, not established: X.", reconciled: true } }
  });
  assert.equal(outcome.next, "Add more evidence, or a correction of an earlier record, then run the investigation again.");
});
