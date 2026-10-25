import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { ROOT_DIR } from "../src/config.js";
import { deskApi } from "../src/investigation/api.js";
import { testConfig, withDesk } from "./helpers.js";

// Decisive mode (public/decisive.js): an experimental reading that accepts a
// stateless answer only when every record it cites still counts and Speck
// holds or points to the same explanation. It never changes Speck's state.

const decisive = await import(pathToFileURL(path.join(ROOT_DIR, "public", "decisive.js")).href) as any;
const BANK = path.join(ROOT_DIR, "eval", "scenarios", "correction-supersedes");
const replaced = new Map([["EV-CAR-003", "EV-CAR-005"]]);
const visible = ["EV-CAR-003", "EV-CAR-005", "EV-SUP-006"];

test("the rule: agreement on records that still count concludes; anything else falls back to Speck", () => {
  const read = (speck: object, stateless: object) => decisive.decisiveReading({ speck, stateless, replaced, visible });

  const agree = read({ concluded: null, tentative: "H-MIS" }, { concluded: "H-MIS", cited: ["EV-CAR-005", "EV-SUP-006"], error: null });
  assert.deepEqual([agree.conclusion, agree.basis], ["H-MIS", "agreement"], "Speck points to it, the stateless answer concludes it on valid records");

  const stale = read({ concluded: null, tentative: "H-MIS" }, { concluded: "H-DEL", cited: ["EV-CAR-003"], error: null });
  assert.deepEqual([stale.conclusion, stale.basis, stale.rejected], [null, "none", ["EV-CAR-003"]]);
  assert.match(stale.reason, /EV-CAR-003 \(replaced by EV-CAR-005\)/);

  const staleButSame = read({ concluded: null, tentative: "H-DEL" }, { concluded: "H-DEL", cited: ["EV-CAR-003"], error: null });
  assert.equal(staleButSame.conclusion, null, "agreement does not rescue an answer resting on a replaced record");

  const invented = read({ concluded: "H-MIS", tentative: null }, { concluded: "H-MIS", cited: ["EV-NOPE-1"], error: null });
  assert.deepEqual([invented.conclusion, invented.basis], ["H-MIS", "speck"], "Speck's own firm conclusion stands");
  assert.match(invented.reason, /not in the evidence/);

  assert.deepEqual([read({ concluded: "H-MIS", tentative: null }, { concluded: "H-DEL", cited: ["EV-SUP-006"], error: null }).basis], ["speck"], "disagreement: Speck's firm conclusion");
  assert.equal(read({ concluded: null, tentative: "H-MIS" }, { concluded: "H-DEL", cited: ["EV-SUP-006"], error: null }).conclusion, null, "disagreement with a tentative Speck: nothing");
  assert.equal(read({ concluded: null, tentative: "H-MIS" }, { concluded: null, cited: [], error: null }).conclusion, null, "an unresolved answer adds nothing");
  assert.equal(read({ concluded: null, tentative: "H-MIS" }, { concluded: "H-MIS", cited: [], error: null }).conclusion, null, "an answer citing nothing is not accepted");
  assert.equal(read({ concluded: "H-MIS", tentative: null }, { concluded: null, cited: [], error: "model: timeout" }).conclusion, "H-MIS", "a failed call leaves Speck's conclusion");
});

test("on every saved comparison, decisive mode never accepts an answer that rests on a replaced record", () => {
  const dir = path.join(ROOT_DIR, "eval", "results", "comparisons");
  let stages = 0;
  for (const scenario of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name) : []) {
    for (const file of fs.readdirSync(path.join(dir, scenario)).filter((name) => name.endsWith(".json"))) {
      const report = JSON.parse(fs.readFileSync(path.join(dir, scenario, file), "utf8"));
      for (const stage of report.stages) {
        stages += 1;
        const reading = decisive.decisiveForStage(stage);
        if (stage.checks.stateless.supportFromReplaced.length) assert.equal(reading.basis === "agreement", false, `${scenario}/${file} ${stage.stage.id}`);
        if (reading.basis === "agreement") assert.equal(reading.conclusion, stage.speck.concluded ?? stage.speck.tentative);
      }
    }
  }
  assert.ok(stages > 0, "the saved comparisons are in the repository");
});

test("the second opinion reads the case as it stands, and the page treats it as stale once the case moves", async () => {
  const config = testConfig({ scenarioDir: BANK });
  await withDesk(config, async (desk) => {
    const api = deskApi(desk, config, "test");
    assert.deepEqual(api.opinion(), { opinion: null });
    await desk.run();
    const { opinion } = await api.requestOpinion() as any;
    assert.equal(opinion.kind, "deterministic");
    assert.equal(opinion.runNumber, 1);
    assert.deepEqual(opinion.visible, ["EV-BNK-101", "EV-LDG-102"]);
    assert.equal(opinion.answer.method, "rules");
    assert.equal(opinion.answer.concluded, "H-PAID");
    assert.deepEqual((api.opinion() as any).opinion, opinion, "kept for the page");

    const view = async () => ({ status: api.status(), investigation: api.investigation(), listing: await api.evidence() }) as any;
    assert.equal(decisive.opinionCurrent(opinion, await view()), true);
    const runsBefore = desk.runs().length;

    // The update arrives: records pending, a new stage. The opinion is stale.
    await desk.introduceNextUpdate();
    assert.equal(decisive.opinionCurrent(opinion, await view()), false);
    await desk.run();
    const after = (await api.requestOpinion() as any).opinion;
    assert.deepEqual(after.replaced, [{ recordId: "EV-BNK-101", by: "EV-BNK-103" }]);
    assert.equal(decisive.opinionCurrent(after, await view()), true);
    const c = desk.conclusionFromSpeck();
    const reading = decisive.decisiveReading({
      speck: { concluded: c.state === "supported" ? c.hypothesis!.key : null, tentative: c.hypothesis?.key ?? null },
      stateless: after.answer, replaced: new Map(after.replaced.map((item: any) => [item.recordId, item.by])), visible: after.visible
    });
    assert.equal(reading.conclusion, "H-UNPAID");
    assert.equal(desk.runs().length, runsBefore + 1, "asking for an opinion runs nothing on the case");
  });
});

test("decisive mode's stateless call is made with reasoning on, and an identifier split by the model is read as written", async () => {
  // A stand-in Ollama: it records each request's reasoning setting and
  // answers as Nemotron Nano 4B does with reasoning on ("H- UNPAID").
  const seen: Array<string | undefined> = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      seen.push(JSON.parse(body).reasoning_effort);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ model: "nemotron-stand-in", choices: [{ message: { role: "assistant",
        content: JSON.stringify({ conclusion: "H- UNPAID", cited_evidence: ["EV- BNK-103"], rationale: "The bank returned the payment - it was not paid." }) } }] }));
    });
  }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  try {
    const config = testConfig({ scenarioDir: BANK }, { REASONER: "nemotron", MODEL_PROVIDER: "ollama", NEMOTRON_BASE_URL: url, NEMOTRON_MODEL: "nemotron-stand-in", NEMOTRON_REASONING_EFFORT: "none" });
    assert.equal(config.nemotron.decisiveReasoningEffort, "medium", "on by default for Ollama");
    await withDesk(config, async (desk) => {
      const { opinion } = await deskApi(desk, config, "test").requestOpinion() as any;
      assert.deepEqual(seen, ["medium"], "one call, with reasoning on, although the assessor's is off");
      assert.deepEqual([opinion.answer.concluded, opinion.answer.cited, opinion.model.reasoningEffort], ["H-UNPAID", ["EV-BNK-103"], "medium"]);
      assert.equal(opinion.answer.rationale, "The bank returned the payment - it was not paid.", "ordinary text is left as written");
    });
  } finally {
    server.close();
  }
  assert.equal(testConfig({}, { MODEL_PROVIDER: "nvidia" }).nemotron.decisiveReasoningEffort, "", "the provider's default where the parameter may be refused");
  assert.equal(testConfig({}, { MODEL_PROVIDER: "ollama", NEMOTRON_DECISIVE_REASONING_EFFORT: "none" }).nemotron.decisiveReasoningEffort, "none");
});

test("the preference is per viewer and off when storage is unavailable", () => {
  const map = new Map<string, string>();
  const storage = { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => void map.set(key, value) };
  const preference = decisive.decisivePreference(storage);
  assert.equal(preference.on(), false, "off by default");
  preference.set(true);
  assert.equal(decisive.decisivePreference(storage).on(), true);
  const broken = decisive.decisivePreference({ getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
  broken.set(true);
  assert.equal(broken.on(), false);
});
