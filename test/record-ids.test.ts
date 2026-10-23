import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ROOT_DIR } from "../src/config.js";
import { tempDir, testConfig, withDesk } from "./helpers.js";

// Record ids that contain "/" and ":", as the Zetaris USL derives them from
// each source's own reference (carrier:tracking/PCL-88412/events/7). The case
// must reach exactly the beliefs it reaches with plain ids.

function withPathIds(dir: string): string {
  const evidence = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "fixtures", "scenarios", "disputed-delivery", "evidence.json"), "utf8")) as { records: Array<{ id: string; provenance: { recordRef: string; supersedes: string[] } }> };
  const idOf = new Map(evidence.records.map((record) => [record.id, `${record.id.split("-")[1]!.toLowerCase()}:${record.provenance.recordRef}`]));
  for (const record of evidence.records) {
    record.id = idOf.get(record.id)!;
    record.provenance.supersedes = record.provenance.supersedes.map((id) => idOf.get(id)!);
  }
  fs.cpSync(path.join(ROOT_DIR, "fixtures", "scenarios", "disputed-delivery"), dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "evidence.json"), JSON.stringify(evidence));
  return dir;
}

const beliefs = (desk: Parameters<Parameters<typeof withDesk>[1]>[0]) => desk.hypotheses().map((view) => [view.key, view.status, view.confidence, view.supporting.length, view.contradicting.length]);

test("record ids containing '/' and ':' give the same beliefs, history and trace as plain ids", async () => {
  const plain = await withDesk(testConfig(), async (desk) => {
    await desk.run(); await desk.introduceNextUpdate(); await desk.run();
    return { beliefs: beliefs(desk), state: desk.conclusionFromSpeck().state };
  });
  const scenarioDir = withPathIds(path.join(tempDir(), "scenario"));
  try {
    const config = testConfig({ scenarioDir });
    await withDesk(config, async (desk) => {
      await desk.run(); await desk.introduceNextUpdate(); await desk.run();
      assert.deepEqual(beliefs(desk), plain.beliefs);
      const conclusion = desk.conclusionFromSpeck();
      assert.equal(conclusion.state, plain.state);
      assert.deepEqual(conclusion.noLongerCounted.map((item) => item.recordId), ["car:tracking/PCL-88412/events/7"]);
      assert.ok((await desk.listEvidence()).records.every((record) => record.status === "completed"));
      // The timeline and the trace name the same ids.
      assert.ok(desk.timeline().some((entry) => entry.title.includes("car:tracking/PCL-88412/pod-review/1")));
      const recorded = desk.trace().flatMap((entry) => entry.kind === "run" ? entry.steps.flatMap((step) => (step as { speck?: { recorded: string[] } }).speck?.recorded ?? []) : []);
      assert.ok(recorded.includes("sup:calls/C-90233"), recorded.join(", "));
    });
    // And after a restart.
    await withDesk(config, async (desk) => assert.deepEqual(beliefs(desk), plain.beliefs));
  } finally {
    fs.rmSync(scenarioDir, { recursive: true, force: true });
  }
});
