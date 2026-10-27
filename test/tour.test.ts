import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { ROOT_DIR } from "../src/config.js";
import { deskApi } from "../src/investigation/api.js";
import { testConfig, withDesk } from "./helpers.js";

// The guided tour and feature guide (public/tour.js) over real API payloads:
// each view is what the page would receive from the API at that point.

const tour = await import(pathToFileURL(path.join(ROOT_DIR, "public", "tour.js")).href) as any;
const json = (value: unknown) => JSON.parse(JSON.stringify(value));

async function snapshot(api: ReturnType<typeof deskApi>) {
  return { status: json(api.status()), investigation: json(api.investigation()), listing: json(await api.evidence()), trace: json(api.trace()) };
}

const step = (id: string) => tour.TOUR_STEPS.find((item: any) => item.id === id);
const text = (items: unknown[]): string => items.flat(Infinity).join("\n");

test("each action step completes only once its real action has happened, and describes the real result", async () => {
  const config = testConfig();
  await withDesk(config, async (desk) => {
    const api = deskApi(desk, config, "test");
    const fresh = await snapshot(api);
    assert.equal(tour.stepDone(step("run"), fresh), false);
    assert.match(text(step("case").body(fresh)), /H-DELIVERED.*\n.*H-MISDELIVERED.*\n.*H-NOT-SHIPPED/s, "the competing explanations come from the case");
    assert.match(text(step("run").body(fresh)), /local fixture file.*deterministic fact rules/s);

    await desk.run();
    const afterRun = await snapshot(api);
    assert.equal(tour.stepDone(step("run"), afterRun), true);
    assert.equal(tour.stepDone(step("update"), afterRun), false);
    assert.match(text(step("run").after(afterRun)), /Run 1 finished.*Leading, not established/s);
    assert.match(text(step("conclusion").body(afterRun)), /Leading:.*Speck confidence 0\.61.*not a calibrated probability/s);
    assert.equal(tour.recordToInspect(afterRun).id, afterRun.investigation.current.hypothesis.supporting[0].recordId);

    await desk.introduceNextUpdate();
    const afterUpdate = await snapshot(api);
    assert.equal(tour.stepDone(step("update"), afterUpdate), true);
    assert.equal(tour.stepDone(step("rerun"), afterUpdate), false, "the new records are not yet assessed");
    assert.match(text(step("update").after(afterUpdate)), /Waiting to be assessed: EV-CAR-005, EV-SUP-006/);

    await desk.run();
    const afterRerun = await snapshot(api);
    assert.equal(tour.stepDone(step("rerun"), afterRerun), true);
    assert.match(text(step("rerun").after(afterRerun)), /Run 2 finished.*wrong address.*run 1 had concluded: leading H-DELIVERED/s);
    assert.match(text(step("changed").body(afterRerun)), /EV-CAR-003 no longer counts: its source replaced it with EV-CAR-005/);
    assert.match(text(step("history").body(afterRerun)), /2 earlier belief\(s\) are kept as history/);
  });
});

test("the feature guide marks a feature demonstrated only from real state, and says what is unavailable", async () => {
  const config = testConfig();
  await withDesk(config, async (desk) => {
    const api = deskApi(desk, config, "test");
    const feature = (id: string) => tour.FEATURES.find((item: any) => item.id === id);
    const none = new Set<string>();
    const fresh = await snapshot(api);
    assert.equal(tour.featureStatus(feature("supersession"), fresh, none).state, "not yet");
    assert.equal(tour.featureStatus(feature("timeline"), fresh, new Set(["timeline"])).state, "viewed");
    const zetaris = tour.featureStatus(feature("zetaris"), fresh, none);
    assert.deepEqual([zetaris.available, zetaris.state], [false, "not yet"]);
    assert.match(zetaris.note, /fixture file/);
    assert.equal(tour.featureStatus(feature("explanation"), fresh, none).available, false);

    await desk.run();
    await desk.introduceNextUpdate();
    await desk.run();
    const done = await snapshot(api);
    for (const id of ["run", "update", "supersession"]) assert.equal(tour.featureStatus(feature(id), done, none).state, "demonstrated", id);
    for (const id of ["withdraw", "recovery", "judgments"]) assert.equal(tour.featureStatus(feature(id), done, none).state, "not yet", id);
    await desk.withdrawRecord("EV-SUP-006", "test");
    assert.equal(tour.featureStatus(feature("withdraw"), await snapshot(api), none).state, "demonstrated");
  });
});

test("progress is kept per viewer when storage works, and the page still works when it does not", () => {
  const map = new Map<string, string>();
  const storage = { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); } };
  const store = tour.progressStore(storage, "/api");
  assert.equal(store.introDismissed(), false);
  store.dismissIntro();
  store.setTourStep(3);
  store.markViewed("trace");
  const again = tour.progressStore(storage, "/api");
  assert.deepEqual([again.introDismissed(), again.tourStep(), [...again.viewed()]], [true, 3, ["trace"]]);
  again.setTourStep(null);
  assert.equal(again.tourStep(), null);
  store.setTourStep(99);
  assert.equal(store.tourStep(), null, "an out-of-range step is ignored");
  assert.equal(tour.progressStore(storage, "/other").introDismissed(), false, "kept per case");

  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  const fallback = tour.progressStore(broken, "/api");
  fallback.dismissIntro();
  assert.deepEqual([fallback.introDismissed(), fallback.tourStep(), fallback.viewed().size], [false, null, 0]);
  assert.equal(tour.progressStore(null, "/api").tourStep(), null);
});

test("every step renders on an empty view, and every target exists on the page", () => {
  const empty = { status: null, investigation: null, listing: null, trace: null };
  for (const item of tour.TOUR_STEPS) {
    assert.doesNotThrow(() => item.body(empty), item.id);
    assert.equal(tour.stepDone(item, empty), !item.goal, item.id);
  }
  const app = fs.readFileSync(path.join(ROOT_DIR, "public", "app.js"), "utf8");
  const targets = app.slice(app.indexOf("const TARGETS = {"), app.indexOf("};", app.indexOf("const TARGETS = {")));
  // A target that follows the state: every value it can take.
  const ran = { ...empty, status: { stage: { id: "s1" }, nextStage: { id: "s2" } }, investigation: { runs: [{ stage: { id: "s1" } }], latestRun: { stage: { id: "s1" } } }, listing: { pending: [] } };
  const targetsOf = (item: any) => typeof item.target === "function" ? [item.target(empty), item.target(ran)] : [item.target];
  for (const target of new Set([...tour.TOUR_STEPS, ...tour.FEATURES].flatMap(targetsOf))) {
    assert.match(targets, new RegExp(`(^|\\s|")${target}"?:`, "m"), target);
  }
});

test("a leading explanation at or above the threshold says why it is not established, not \"0 short\"", async () => {
  await withDesk(testConfig(), async (desk) => {
    await desk.run();
    const reasons = desk.conclusionFromSpeck().justification!.reasons.join(" ");
    assert.doesNotMatch(reasons, /\b0 short\b/);
    assert.match(reasons, /H-DELIVERED is at 0\.61, at or above Speck's supported threshold of 0\.6, but Speck holds it as weakening/);
  });
});

test("the guided walk alternates update and run through every stage, and only the guided demo has it", () => {
  const walk = step("walk");
  const at = (stage: string, next: string | null, runStage: string | null, pending: string[] = []) => ({
    status: { stage: { id: stage, label: stage }, nextStage: next ? { id: next, label: next } : null, stages: [] },
    investigation: { runs: runStage ? [{ runNumber: 1, stage: { id: runStage, label: runStage }, conclusion: "unresolved", hypothesis: null }] : [], latestRun: runStage ? { stage: { id: runStage } } : null, current: null },
    listing: { pending }
  });
  assert.equal(tour.actionOf(walk, at("s1", "s2", null)), "run");
  assert.equal(tour.actionOf(walk, at("s1", "s2", "s1")), "update");
  assert.equal(tour.targetOf(walk, at("s1", "s2", "s1")), "update-button");
  assert.equal(tour.actionOf(walk, at("s2", "s3", "s1", ["EV-1"])), "run");
  assert.equal(tour.targetOf(walk, at("s2", "s3", "s1", ["EV-1"])), "run-button");
  assert.equal(tour.stepDone(walk, at("s2", "s3", "s2")), false, "a stage is still to come");
  assert.equal(tour.stepDone(walk, at("s3", null, "s2")), false, "the last stage is not run yet");
  assert.equal(tour.stepDone(walk, at("s3", null, "s3")), true);
  assert.equal(walk.guidedOnly, true, "the case's own tour leaves it out");
});

test("the hotel chargeback's walk ends with every stage assessed, and its restated records say what their source now reports", async () => {
  const config = testConfig({ scenarioDir: path.join(ROOT_DIR, "eval", "challenge-7", "hotel-chargeback") });
  await withDesk(config, async (desk) => {
    const api = deskApi(desk, config, "test");
    await desk.run();
    while ((await snapshot(api)).status.nextStage) {
      assert.equal(tour.stepDone(step("walk"), await snapshot(api)), false);
      await desk.introduceNextUpdate();
      await desk.run();
    }
    const done = await snapshot(api);
    assert.equal(tour.stepDone(step("walk"), done), true);
    const changed = text(step("changed").body(done));
    assert.match(changed, /N7H-01 no longer counts: it is out of date: its source now reports .+=/);
    assert.doesNotMatch(changed + text(step("walk").after(done)), /undefined/);
  });
});
