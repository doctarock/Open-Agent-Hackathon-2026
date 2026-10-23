import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { testConfig, withDesk } from "./helpers.js";

// A stand-in OpenAI-compatible endpoint. It exercises the real Nemotron
// adapter and Speck's processor over HTTP without any credential; it is not
// evidence that Nemotron itself was used (see `npm run model:check`).
interface SeenRequest { model: string; authorization?: string; maxTokens: number; reasoningEffort?: string }

async function fakeEndpoint(reply: (prompt: string) => unknown): Promise<{ url: string; requests: SeenRequest[]; close: () => void }> {
  const requests: SeenRequest[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body);
      requests.push({ model: parsed.model, authorization: request.headers.authorization, maxTokens: parsed.max_tokens, reasoningEffort: parsed.reasoning_effort });
      const prompt = parsed.messages.at(-1).content as string;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        model: parsed.model,
        choices: [{ message: { role: "assistant", content: JSON.stringify(reply(prompt)) } }],
        usage: { prompt_tokens: 100, completion_tokens: 20 }
      }));
    });
  }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/v1`, requests, close: () => server.close() };
}

const chunkIds = (prompt: string) => [...(prompt.split("EVIDENCE IN THIS CHUNK:")[1] ?? "").matchAll(/^\[(EV-[A-Z]+-\d+)\]/gm)].map((match) => match[1]!);

const nemotronEnv = (url: string) => ({
  REASONER: "nemotron", NEMOTRON_BASE_URL: url, NEMOTRON_MODEL: "test/nemotron-stand-in", NEMOTRON_API_KEY_ENV: "EVIDENCE_DESK_TEST_KEY", EVIDENCE_DESK_TEST_KEY: "test-key-not-a-secret",
  NEMOTRON_REASONING_EFFORT: "none"
});

test("model judgments go through Speck; decisive rules win; invented citations are flagged", async () => {
  const endpoint = await fakeEndpoint((prompt) => {
    if (prompt.includes("cited_evidence")) {
      // Declares an established conclusion, whatever Speck holds.
      return { explanation: "The carrier delivery scan supports delivery, though the customer disputes it.", cited_evidence: ["EV-CAR-003", "EV-INVENTED-9"], stated_conclusion: "H-DELIVERED", stated_established: true };
    }
    const judgments = chunkIds(prompt).flatMap((id) => {
      if (id === "EV-CAR-003") return [{ evidence_id: id, hypothesis: "H-DELIVERED", relation: "supports", strength: 0.9, rationale: "delivery scan" }];
      if (id === "EV-SUP-004") return [{ evidence_id: id, hypothesis: "H-DELIVERED", relation: "contradicts", strength: 0.5, rationale: "customer was home" }];
      if (id === "EV-WMS-002") return [
        { evidence_id: id, hypothesis: "H-NOT-SHIPPED", relation: "supports", strength: 0.4, rationale: "contrary to the decisive rule" },
        { evidence_id: id, hypothesis: "H-MADE-UP", relation: "supports", strength: 1, rationale: "not a hypothesis" }
      ];
      return [{ evidence_id: id, hypothesis: "H-DELIVERED", relation: "neutral", strength: 0.1, rationale: "no bearing" }];
    });
    return { judgments, summary: `Assessed ${chunkIds(prompt).join(", ")}.` };
  });
  try {
    await withDesk(testConfig({}, nemotronEnv(endpoint.url)), async (desk) => {
      const run = await desk.run();
      assert.equal(run.execution.status, "completed");
      assert.equal(run.reasoner.kind, "nemotron");
      assert.equal(run.reasoner.model, "test/nemotron-stand-in");
      assert.equal(run.reasonerUsage?.successes, 3, "two evidence chunks and one explanation");
      assert.ok(endpoint.requests.every((request) => request.model === "test/nemotron-stand-in" && request.authorization === "Bearer test-key-not-a-secret"));
      assert.ok(endpoint.requests.every((request) => request.maxTokens === 4096 && request.reasoningEffort === "none"));
      assert.deepEqual(run.reasonerUsage?.servedModels, ["test/nemotron-stand-in"], "the model name the endpoint reported");

      const wms = run.assessed.find((item) => item.record.id === "EV-WMS-002")!;
      assert.deepEqual(wms.judgments.map((judgment) => [judgment.hypothesisKey, judgment.direction, judgment.basis, judgment.decisive]), [["H-NOT-SHIPPED", "contradicts", "rule", true]]);
      assert.ok(run.notes.some((note) => /kept the rule judgment/.test(note)));
      assert.ok(run.notes.some((note) => /unknown hypothesis "H-MADE-UP"/.test(note)));
      const car = run.assessed.find((item) => item.record.id === "EV-CAR-003")!;
      assert.equal(car.recordedBy, "model");
      assert.equal(car.judgments[0]!.basis, "model");

      // Speck applied its model reliability ceiling to model-judged evidence.
      const evidence = desk.runtime.mentalObjects.listAll().find((object) => object.kind === "evidence" && String(object.data.source).endsWith("/EV-CAR-003"))!;
      assert.equal(evidence.provenance.kind, "model");
      assert.equal(evidence.data.reliability, 0.4);

      assert.deepEqual(run.explanation?.invalidCitations, ["EV-INVENTED-9"]);
      assert.ok(run.notes.some((note) => /cites evidence that does not exist: EV-INVENTED-9/.test(note)));
      // The explanation claims an established conclusion; Speck does not hold one.
      assert.equal(run.conclusion.justification.established, false);
      assert.equal(run.explanation?.agreement.agrees, false);
      assert.ok(run.explanation?.agreement.problems.some((problem) => /presents the conclusion as established; Speck holds it as not established/.test(problem)));
      assert.equal(run.reasonerUsage?.httpCalls.length, 3);
      assert.ok(run.reasonerUsage?.httpCalls.every((call) => call.answered && call.latencyMs >= 0));
      // The conclusion is Speck's, whatever the explanation says.
      assert.equal(run.conclusion.hypothesis?.key, desk.conclusionFromSpeck().hypothesis?.key);
    });
  } finally {
    endpoint.close();
  }
});

test("a record the model says nothing about stays pending instead of counting as no bearing", async () => {
  // Answers every pair except those about EV-WMS-002, whose decisive rule
  // judgment would otherwise be recorded as if the model had agreed.
  const endpoint = await fakeEndpoint((prompt) => {
    if (prompt.includes("cited_evidence")) return { explanation: "Unresolved.", cited_evidence: [], stated_conclusion: "unresolved", stated_established: false };
    const ids = chunkIds(prompt).filter((id) => id !== "EV-WMS-002");
    return { judgments: ids.map((id) => ({ evidence_id: id, hypothesis: "H-DELIVERED", relation: "neutral", strength: 0.1, rationale: "no bearing" })), summary: "" };
  });
  try {
    await withDesk(testConfig({}, nemotronEnv(endpoint.url)), async (desk) => {
      const run = await desk.run();
      assert.ok(!run.assessed.some((item) => item.record.id === "EV-WMS-002"));
      assert.deepEqual(run.unprocessed, ["EV-WMS-002"]);
      assert.ok(run.notes.some((note) => /The model returned no judgment for EV-WMS-002/.test(note)));
      assert.deepEqual((await desk.listEvidence()).pending, ["EV-WMS-002"]);
      const notShipped = desk.hypotheses().find((view) => view.key === "H-NOT-SHIPPED")!;
      assert.equal(notShipped.status, "proposed", "neither refuted nor supported by a record that was never judged");
      assert.deepEqual(notShipped.contradicting, []);
    });
  } finally {
    endpoint.close();
  }
});

test("the trace records each Nemotron call: served model, constraints, contract retries, and what was kept", async () => {
  let assessmentCalls = 0;
  const endpoint = await fakeEndpoint((prompt) => {
    if (prompt.includes("cited_evidence")) {
      return { explanation: "Delivered.", cited_evidence: ["EV-CAR-003", "EV-INVENTED-9"], stated_conclusion: "H-DELIVERED", stated_established: true };
    }
    assessmentCalls += 1;
    // The first reply breaks the contract; Speck's registry rejects it and asks again.
    if (assessmentCalls === 1) return { summary: "missing the judgments array" };
    const judgments = chunkIds(prompt).flatMap((id) => {
      if (id === "EV-WMS-002") return [
        { evidence_id: id, hypothesis: "H-NOT-SHIPPED", relation: "supports", strength: 0.4, rationale: "contrary to the decisive rule" },
        { evidence_id: id, hypothesis: "H-MADE-UP", relation: "supports", strength: 1, rationale: "not a hypothesis" }
      ];
      if (id === "EV-CAR-003") return [
        { evidence_id: id, hypothesis: "H-DELIVERED", relation: "supports", strength: 0.9, rationale: "scan" },
        { evidence_id: id, hypothesis: "H-DELIVERED", relation: "supports", strength: 0.9, rationale: "scan, repeated" }
      ];
      return [{ evidence_id: id, hypothesis: "H-DELIVERED", relation: "neutral", strength: 0.1, rationale: "no bearing" }];
    });
    return { judgments, summary: "" };
  });
  try {
    await withDesk(testConfig({}, nemotronEnv(endpoint.url)), async (desk) => {
      const run = await desk.run();
      const trace = desk.trace().find((entry) => entry.kind === "run")!;
      assert.ok(trace.kind === "run");
      assert.deepEqual(trace.reasoner, { kind: "nemotron", model: "test/nemotron-stand-in", endpoint: endpoint.url });
      const [first, second] = trace.steps.filter((step) => step.kind === "chunk").map((step) => step.kind === "chunk" ? step : null);
      // Chunk 1: one rejected reply, then a valid one, all reported by the endpoint as the stand-in model.
      assert.deepEqual([first!.model!.attempts, first!.model!.contractFailures, first!.model!.transportFailures, first!.model!.outcome], [2, 1, 0, "valid"]);
      assert.equal(first!.model!.httpCalls.length, 2);
      assert.deepEqual(first!.model!.servedModels, ["test/nemotron-stand-in"]);
      assert.deepEqual(first!.model!.constraints, { contract: "evidence_relations", requiredPairs: 6, temperature: 0.1, maxAttempts: 2, maxTokens: 4096, reasoningEffort: "none" });
      // What was kept: the unknown hypothesis discarded, the decisive rule kept over the model.
      assert.deepEqual(first!.model!.judgments, { returned: 3, neutral: 1, kept: 0, discardedUnknown: 1, ruleKept: 1, repeated: 0, unanswered: [] });
      assert.deepEqual(first!.judgments, { rule: 1, model: 0, noBearing: ["EV-OMS-001"] });
      // Chunk 2: the repeated pair is counted, not silently dropped.
      assert.deepEqual([second!.model!.attempts, second!.model!.judgments!.kept, second!.model!.judgments!.repeated, second!.model!.judgments!.neutral], [1, 1, 1, 1]);
      assert.equal(trace.flags.retries, 1);
      assert.equal(trace.flags.contractFailures, 1);
      // The evidence list shows the source's reliability and what Speck applied after its cap.
      const car = (await desk.listEvidence()).records.find((record) => record.id === "EV-CAR-003")!;
      assert.deepEqual([car.assessment?.recordedBy, car.assessment?.reliability, car.assessment?.appliedReliability], ["model", 0.85, 0.4]);
      // The explanation call and its invented citation.
      const explanation = trace.steps.find((step) => step.kind === "explanation")!;
      assert.ok(explanation.kind === "explanation");
      assert.equal(explanation.model?.constraints.contract, "investigation_explanation");
      assert.deepEqual(explanation.invalidCitations, ["EV-INVENTED-9"]);
      assert.deepEqual(trace.flags.invalidCitations, run.explanation!.invalidCitations);
      assert.equal(explanation.agrees, false);
    });
  } finally {
    endpoint.close();
  }
});

test("a non-Nemotron or unset model is refused before anything runs", async () => {
  await withDesk(testConfig({}, { REASONER: "nemotron", MODEL_PROVIDER: "ollama" }), async (desk) => {
    assert.equal(desk.reasoner.describe().ready, false);
    await assert.rejects(desk.run(), /NEMOTRON_MODEL is not set/);
    assert.equal(desk.runs().length, 0);
  });
  await withDesk(testConfig({}, { REASONER: "nemotron", NEMOTRON_BASE_URL: "http://127.0.0.1:9/v1", NEMOTRON_MODEL: "llama3.1:8b" }), async (desk) => {
    await assert.rejects(desk.run(), /does not name a Nemotron model/);
  });
});

test("an unreachable model endpoint fails the run visibly", async () => {
  await withDesk(testConfig({}, { ...nemotronEnv("http://127.0.0.1:9/v1"), NEMOTRON_TIMEOUT_MS: "2000" }), async (desk) => {
    const run = await desk.run();
    assert.equal(run.execution.status, "errored");
    assert.match(run.execution.error ?? "", /Model processor "nemotron" failed/);
    assert.match(run.execution.error ?? "", /unreachable/);
    assert.equal(run.assessed.length, 0);
    assert.equal(run.reasonerUsage?.successes, 0);
    assert.deepEqual(run.reasonerUsage?.servedModels, []);
    assert.equal(run.explanation, null);
    // No evidence was assessed, so no hypothesis may be offered on its prior alone.
    assert.equal(run.conclusion.state, "unresolved");
    assert.equal(run.conclusion.hypothesis, null);
  });
});
