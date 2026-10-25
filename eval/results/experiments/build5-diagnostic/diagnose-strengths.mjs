// Diagnostic only (Build 5, section 1): run Evidence Desk live on already-seen
// suites, exactly as the eval's speck-desk system does, and record for every
// checkpoint the judgments behind each current hypothesis (basis, strength,
// source system). Writes one JSON per repeat to the directory given.
import fs from "node:fs";
import path from "node:path";
const ROOT = "E:/AI/Open-Agent-Hackathon-2026";
const url = (p) => new URL(`file:///${ROOT}/dist/src/${p}`).href;
const { loadConfig } = await import(url("config.js"));
const { loadEvalCases, REGRESSION_DIR, CHALLENGE_DIR, EVAL_DIR } = await import(url("eval/cases.js"));
const { caseConfig, deskOptions } = await import(url("eval/systems.js"));
const { EvidenceDesk } = await import(url("investigation/desk.js"));

const [outDir, repeatsArg] = process.argv.slice(2);
const repeats = Number(repeatsArg ?? 1);
const nemotron = loadConfig({ REASONER: "nemotron", MODEL_PROVIDER: "ollama", NEMOTRON_BASE_URL: "http://127.0.0.1:11434/v1", NEMOTRON_TIMEOUT_MS: "300000",
  NEMOTRON_MODEL: "nemotron-3-nano:4b", NEMOTRON_REASONING_EFFORT: "none", NEMOTRON_MAX_TOKENS: "4096" }).nemotron;
const reasoner = { kind: "nemotron", config: nemotron };
const suites = [["held-out", EVAL_DIR], ["regression", REGRESSION_DIR], ["challenge", CHALLENGE_DIR]];
fs.mkdirSync(outDir, { recursive: true });
const ref = (r) => ({ id: r.recordId, system: r.sourceSystem, basis: r.judgment?.basis ?? null, strength: r.judgment?.strength ?? null, counts: !r.supersededBy, rationale: r.judgment?.rationale ?? null });
for (let repeat = 1; repeat <= repeats; repeat++) {
  const out = [];
  for (const [suite, dir] of suites) {
    for (const item of loadEvalCases(dir)) {
      if (item.provider !== "fixture") continue;
      const config = caseConfig(item, reasoner);
      const desk = await EvidenceDesk.open(config, deskOptions(item, config, reasoner));
      try {
        for (const checkpoint of item.checkpoints) {
          while (desk.currentStage().id !== checkpoint.afterStage) await desk.introduceNextUpdate();
          for (const w of checkpoint.withdrawBefore ?? []) await desk.withdrawRecord(w.recordId, w.reason);
          let entry = { suite, caseId: item.id, stage: checkpoint.afterStage, label: checkpoint.conclusion };
          try {
            const run = await desk.run();
            const c = desk.conclusionFromSpeck();
            const views = [c.hypothesis, ...c.alternatives, ...c.rejected].filter(Boolean);
            entry = { ...entry, state: c.state, route: c.justification.route, concluded: c.state === "supported" ? c.hypothesis.key : null,
              unprocessed: run.unprocessed ?? null, corroboration: c.justification.corroboration,
              hypotheses: views.map((v) => ({ key: v.key, status: v.status, confidence: v.confidence, supporting: v.supporting.map(ref), contradicting: v.contradicting.map(ref) })) };
          } catch (error) { entry.error = String(error?.message ?? error); }
          out.push(entry);
          console.log(`r${repeat} ${suite} ${item.id}@${checkpoint.afterStage}: ${entry.error ?? `${entry.state}${entry.route ? ` (${entry.route})` : ""} ${entry.concluded ?? ""}`}`);
        }
      } finally { desk.close(); }
    }
  }
  fs.writeFileSync(path.join(outDir, `r${repeat}.json`), JSON.stringify({ generatedAt: new Date().toISOString(), model: { provider: nemotron.provider, model: nemotron.model, endpoint: nemotron.baseUrl, reasoningEffort: nemotron.reasoningEffort, maxTokens: nemotron.maxTokens }, repeat, checkpoints: out }, null, 1));
}
