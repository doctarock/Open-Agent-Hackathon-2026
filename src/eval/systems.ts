import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { contractInstruction, parseModelCompletion, type StructuredOutputContract } from "#speck";
import { loadConfig, type AppConfig, type NemotronConfig } from "../config.js";
import { FixtureEvidenceProvider } from "../evidence/fixture-provider.js";
import { byObservation, EvidenceProviderError, type EvidenceProvider, type EvidenceRecord } from "../evidence/types.js";
import { ZetarisEvidenceProvider } from "../evidence/zetaris-provider.js";
import { EvidenceDesk, type RunSnapshot } from "../investigation/desk.js";
import { NemotronProcessor, NemotronReasoner } from "../reasoning/nemotron.js";
import { ruleJudgments } from "../reasoning/rules.js";
import type { EvalCase } from "./cases.js";

// The systems the evaluation compares. Each takes a case and returns, for
// every labelled checkpoint, what it concluded and what it cited.

export interface CheckpointOutcome {
  stage: string;
  // An error the system surfaced instead of a result.
  error: string | null;
  // The hypothesis the system concludes. Speck systems conclude only when
  // Speck holds the hypothesis as supported; "leading" and "points to" are
  // tentative and count as abstaining.
  conclusion: string | null;
  tentative: string | null;
  // Hypotheses presented as current or favoured.
  presentedAsCurrent: string[];
  // Every evidence id the system cited, and those it cited for its conclusion.
  citations: string[];
  supportCitations: string[];
  visibleEvidence: string[];
  // Speck systems with a model: whether the explanation matched Speck's state.
  explanationAgrees: boolean | null;
  executionStatus: string | null;
}

export interface ModelStats {
  httpCalls: Array<{ latencyMs: number; answered: boolean }>;
  // Structured replies attempted and the ones that passed validation.
  contractAttempts: number;
  contractValid: number;
  servedModels: string[];
}

export interface SystemResult {
  checkpoints: CheckpointOutcome[];
  model: ModelStats | null;
}

export interface EvalSystem {
  name: string;
  description: string;
  run(item: EvalCase): Promise<SystemResult>;
}

export type ReasonerChoice = { kind: "rules" } | { kind: "nemotron"; config: NemotronConfig };

const UNREACHABLE_ZETARIS = "http://127.0.0.1:9";

function providerFor(item: EvalCase, config: AppConfig): EvidenceProvider {
  // The failure case uses the real Zetaris adapter against a port nothing
  // listens on: a genuine connection failure, not a stub.
  return item.provider === "zetaris-unreachable"
    ? new ZetarisEvidenceProvider({ ...config.zetaris, baseUrl: UNREACHABLE_ZETARIS, username: "eval", password: "eval-placeholder" })
    : new FixtureEvidenceProvider(path.join(item.dir, "evidence.json"), config.rootDir);
}

function caseConfig(item: EvalCase, reasoner: ReasonerChoice): AppConfig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-desk-eval-"));
  return loadConfig({}, {
    scenarioDir: item.dir, databasePath: path.join(dir, "desk.sqlite"), historyDir: path.join(dir, "meterless"),
    reasoner: reasoner.kind, ...(reasoner.kind === "nemotron" ? { nemotron: reasoner.config } : {})
  });
}

function speckOutcome(stage: string, run: RunSnapshot, visible: string[]): CheckpointOutcome {
  const c = run.conclusion;
  const views = [c.hypothesis, ...c.alternatives, ...c.rejected].flatMap((view) => (view ? [view] : []));
  const concluded = c.state === "supported" ? c.hypothesis : null;
  return {
    stage, error: null,
    conclusion: concluded?.key ?? null,
    tentative: concluded ? null : c.hypothesis?.key ?? c.direction.pointsTo?.key ?? null,
    presentedAsCurrent: [...new Set([c.hypothesis?.key, c.direction.pointsTo?.key].filter((key): key is string => Boolean(key)))],
    citations: [...new Set([...views.flatMap((view) => [...view.supporting, ...view.contradicting].map((ref) => ref.recordId)), ...(run.explanation?.citedEvidence ?? [])])],
    supportCitations: concluded ? concluded.supporting.map((ref) => ref.recordId) : [],
    visibleEvidence: visible,
    explanationAgrees: run.explanation ? run.explanation.agreement.agrees : null,
    executionStatus: run.execution.status
  };
}

function errorOutcome(stage: string, error: unknown): CheckpointOutcome {
  return {
    stage, error: error instanceof EvidenceProviderError ? `evidence: ${error.message}` : `error: ${error instanceof Error ? error.message : String(error)}`,
    conclusion: null, tentative: null, presentedAsCurrent: [], citations: [], supportCitations: [], visibleEvidence: [],
    explanationAgrees: null, executionStatus: null
  };
}

function speckModelStats(desk: EvidenceDesk): ModelStats | null {
  const usage = desk.reasoner.usage();
  return usage ? { httpCalls: usage.httpCalls, contractAttempts: usage.calls, contractValid: usage.successes, servedModels: usage.servedModels } : null;
}

function mergeStats(stats: Array<ModelStats | null>): ModelStats | null {
  const present = stats.filter((item): item is ModelStats => item !== null);
  if (!present.length) return null;
  return {
    httpCalls: present.flatMap((item) => item.httpCalls),
    contractAttempts: present.reduce((sum, item) => sum + item.contractAttempts, 0),
    contractValid: present.reduce((sum, item) => sum + item.contractValid, 0),
    servedModels: [...new Set(present.flatMap((item) => item.servedModels))]
  };
}

async function visibleIds(desk: EvidenceDesk): Promise<string[]> {
  return (await desk.listEvidence()).records.map((record) => record.id);
}

function deskOptions(item: EvalCase, config: AppConfig, reasoner: ReasonerChoice): Parameters<typeof EvidenceDesk.open>[1] {
  return {
    provider: providerFor(item, config),
    ...(reasoner.kind === "nemotron" ? { reasoner: (runtime) => new NemotronReasoner(runtime, reasoner.config) } : {})
  };
}

// Evidence Desk as built: one persistent Speck case across the checkpoints;
// each update is introduced and the investigation rerun.
export function speckDesk(reasoner: ReasonerChoice): EvalSystem {
  return {
    name: `speck-desk/${reasoner.kind}`,
    description: "Evidence Desk: persistent Speck beliefs across checkpoints, incremental evidence.",
    async run(item) {
      const config = caseConfig(item, reasoner);
      const desk = await EvidenceDesk.open(config, deskOptions(item, config, reasoner));
      const checkpoints: CheckpointOutcome[] = [];
      try {
        for (const checkpoint of item.checkpoints) {
          while (desk.currentStage().id !== checkpoint.afterStage) await desk.introduceNextUpdate();
          try {
            const run = await desk.run();
            checkpoints.push(speckOutcome(checkpoint.afterStage, run, await visibleIds(desk)));
          } catch (error) {
            checkpoints.push(errorOutcome(checkpoint.afterStage, error));
          }
        }
        return { checkpoints, model: speckModelStats(desk) };
      } finally {
        desk.close();
      }
    }
  };
}

// The same Speck pipeline with no carried state: a new database for every
// checkpoint, given all evidence visible by then in one run. It separates
// what persistence contributes from what Speck's revision policy does.
export function speckFresh(reasoner: ReasonerChoice): EvalSystem {
  return {
    name: `speck-fresh/${reasoner.kind}`,
    description: "Speck pipeline with a fresh database per checkpoint (no persisted beliefs or history).",
    async run(item) {
      const checkpoints: CheckpointOutcome[] = [];
      const stats: Array<ModelStats | null> = [];
      for (const checkpoint of item.checkpoints) {
        const config = caseConfig(item, reasoner);
        const desk = await EvidenceDesk.open(config, deskOptions(item, config, reasoner));
        try {
          while (desk.currentStage().id !== checkpoint.afterStage) await desk.introduceNextUpdate();
          const run = await desk.run();
          checkpoints.push(speckOutcome(checkpoint.afterStage, run, await visibleIds(desk)));
        } catch (error) {
          checkpoints.push(errorOutcome(checkpoint.afterStage, error));
        } finally {
          stats.push(speckModelStats(desk));
          desk.close();
        }
      }
      return { checkpoints, model: mergeStats(stats) };
    }
  };
}

async function visibleAt(item: EvalCase, provider: EvidenceProvider, stageId: string): Promise<EvidenceRecord[]> {
  const stage = item.scenario.stages.find((candidate) => candidate.id === stageId)!;
  return (await provider.fetchCaseEvidence(item.scenario.caseId))
    .filter((record) => Date.parse(record.observedAt) <= Date.parse(stage.asOf)).sort(byObservation);
}

// A stateless baseline with the scenario's fact rules: at each checkpoint it
// scores every hypothesis afresh as the sum of reliability x strength over
// matching rules (contradictions negative, decisive treated like any other
// rule), and concludes the top score when positive and strictly ahead.
export function statelessRules(): EvalSystem {
  return {
    name: "baseline-stateless/rules",
    description: "No Speck: fact rules scored from scratch at each checkpoint; highest positive score wins.",
    async run(item) {
      const config = caseConfig(item, { kind: "rules" });
      const provider = providerFor(item, config);
      const checkpoints: CheckpointOutcome[] = [];
      for (const checkpoint of item.checkpoints) {
        let records: EvidenceRecord[];
        try {
          records = await visibleAt(item, provider, checkpoint.afterStage);
        } catch (error) {
          checkpoints.push(errorOutcome(checkpoint.afterStage, error));
          continue;
        }
        const scores = new Map(item.scenario.hypotheses.map((hypothesis) => [hypothesis.key, 0]));
        const support = new Map<string, string[]>();
        for (const record of records) {
          const reliability = item.scenario.sources[record.source.system]?.reliability ?? 0.5;
          for (const judgment of ruleJudgments(record, item.scenario.hypotheses)) {
            const sign = judgment.direction === "supports" ? 1 : -1;
            scores.set(judgment.hypothesisKey, scores.get(judgment.hypothesisKey)! + sign * reliability * judgment.strength);
            if (sign > 0) support.set(judgment.hypothesisKey, [...(support.get(judgment.hypothesisKey) ?? []), record.id]);
          }
        }
        const ranked = [...scores].sort((left, right) => right[1] - left[1]);
        const [top, second] = ranked;
        const chosen = top && top[1] > 0 && (!second || top[1] > second[1]) ? top[0] : null;
        const cited = chosen ? support.get(chosen) ?? [] : [];
        checkpoints.push({
          stage: checkpoint.afterStage, error: null, conclusion: chosen, tentative: null,
          presentedAsCurrent: chosen ? [chosen] : [], citations: cited, supportCitations: cited,
          visibleEvidence: records.map((record) => record.id), explanationAgrees: null, executionStatus: null
        });
      }
      return { checkpoints, model: null };
    }
  };
}

const baselineContract = (keys: string[]): StructuredOutputContract => ({
  name: "case_conclusion",
  required: ["conclusion", "cited_evidence", "rationale"],
  properties: {
    conclusion: { type: "string", enum: [...keys, "unresolved"] },
    cited_evidence: { type: "array", items: { type: "string" } },
    rationale: { type: "string" }
  }
});

// A stateless baseline with the same model: at each checkpoint, one prompt
// with the question, the hypotheses and every visible record (text and
// facts), asking for a conclusion or "unresolved" with citations. No Speck
// beliefs, history or prior state; Speck's stateless JSON parser validates the
// reply, with the same two attempts Speck's registry allows.
export function statelessModel(config: NemotronConfig): EvalSystem {
  return {
    name: "baseline-stateless/nemotron",
    description: "No Speck state: one model call per checkpoint over all visible evidence.",
    async run(item) {
      const appConfig = caseConfig(item, { kind: "nemotron", config });
      const provider = providerFor(item, appConfig);
      const processor = new NemotronProcessor(config);
      const keys = item.scenario.hypotheses.map((hypothesis) => hypothesis.key);
      const contract = baselineContract(keys);
      let attempts = 0;
      let valid = 0;
      const checkpoints: CheckpointOutcome[] = [];
      for (const checkpoint of item.checkpoints) {
        let records: EvidenceRecord[];
        try {
          records = await visibleAt(item, provider, checkpoint.afterStage);
        } catch (error) {
          checkpoints.push(errorOutcome(checkpoint.afterStage, error));
          continue;
        }
        const prompt = baselinePrompt(item, records, contract);
        let parsed: Record<string, unknown> | null = null;
        let lastError = "";
        for (let attempt = 1; attempt <= 2 && !parsed; attempt += 1) {
          attempts += 1;
          try {
            const completion = await processor.infer({ prompt, temperature: 0.1, timeoutMs: config.timeoutMs, contract });
            parsed = parseModelCompletion(completion.text, contract).structured;
            valid += 1;
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
          }
        }
        if (!parsed) {
          checkpoints.push(errorOutcome(checkpoint.afterStage, new Error(`model: ${lastError}`)));
          continue;
        }
        const conclusion = parsed.conclusion === "unresolved" ? null : String(parsed.conclusion);
        const cited = (parsed.cited_evidence as unknown[]).map(String);
        checkpoints.push({
          stage: checkpoint.afterStage, error: null, conclusion, tentative: null,
          presentedAsCurrent: conclusion ? [conclusion] : [], citations: cited, supportCitations: conclusion ? cited : [],
          visibleEvidence: records.map((record) => record.id), explanationAgrees: null, executionStatus: null
        });
      }
      return { checkpoints, model: { httpCalls: [...processor.calls], contractAttempts: attempts, contractValid: valid, servedModels: [...processor.servedModels] } };
    }
  };
}

function baselinePrompt(item: EvalCase, records: readonly EvidenceRecord[], contract: StructuredOutputContract): string {
  return [
    `QUESTION: ${item.scenario.question}`,
    "",
    "HYPOTHESES:",
    ...item.scenario.hypotheses.map((hypothesis) => `- ${hypothesis.key}: ${hypothesis.statement}`),
    "",
    "EVIDENCE:",
    ...records.map((record) => [
      `[${record.id}] source: ${record.source.name}; observed ${record.observedAt}${record.provenance.supersedes.length ? `; replaces ${record.provenance.supersedes.join(", ")}` : ""}`,
      `  ${record.content}`,
      `  facts: ${Object.entries(record.facts).map(([key, value]) => `${key}=${value}`).join(", ") || "(none)"}`
    ].join("\n")),
    "",
    "Decide which hypothesis the evidence establishes. Judge only from the evidence above.",
    "If the evidence does not establish one hypothesis, answer \"unresolved\".",
    `conclusion: one of ${[...contract.properties.conclusion!.enum!].map((value) => JSON.stringify(value)).join(", ")}`,
    "cited_evidence: the evidence ids that support your conclusion, only from the list above.",
    "rationale: one or two sentences.",
    "",
    // The same contract instruction Speck appends to every structured call.
    contractInstruction(contract)
  ].join("\n");
}
