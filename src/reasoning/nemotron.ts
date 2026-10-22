import type { ModelProcessor, ModelProcessorDescriptor, ModelRequest, ProcessorCompletion, SpeckRuntime, StructuredOutputContract } from "#speck";
import type { NemotronConfig } from "../config.js";
import type { EvidenceRecord } from "../evidence/types.js";
import type { HypothesisSpec } from "../scenario.js";
import { describeJudgments, ruleJudgments } from "./rules.js";
import type { BatchAssessment, Explanation, Reasoner, ReasonerDescription, ReasonerUsage, RelationJudgment } from "./types.js";

export const NEMOTRON_PROCESSOR_ID = "nemotron";

// One OpenAI-compatible chat completion against the Nemotron endpoint,
// plugged into Speck's model registry. Speck's built-in processor caps output
// at 1024 tokens and cannot turn reasoning off, and a Nemotron reasoning
// trace alone can fill that cap (measured: 935 tokens on a short prompt), so
// this processor sends the configured reasoning effort and output budget. It
// records the model name the endpoint reports serving.
export class NemotronProcessor implements ModelProcessor {
  readonly servedModels = new Set<string>();
  // Every HTTP call as measured here: wall-clock latency and whether the
  // endpoint returned answer content (contract validity is judged later).
  readonly calls: Array<{ latencyMs: number; answered: boolean }> = [];

  constructor(private readonly config: NemotronConfig) {}

  async infer(request: ModelRequest): Promise<ProcessorCompletion> {
    const began = performance.now();
    try {
      const completion = await this.complete(request);
      this.calls.push({ latencyMs: Math.round(performance.now() - began), answered: true });
      return completion;
    } catch (error) {
      this.calls.push({ latencyMs: Math.round(performance.now() - began), answered: false });
      throw error;
    }
  }

  private async complete(request: ModelRequest): Promise<ProcessorCompletion> {
    const base = this.config.baseUrl.replace(/\/+$/, "");
    const apiKey = process.env[this.config.apiKeyEnv];
    const signals = [AbortSignal.timeout(request.timeoutMs), ...(request.signal ? [request.signal] : [])];
    let response: Response;
    try {
      response = await fetch(`${base}${base.endsWith("/v1") ? "" : "/v1"}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({
          model: this.config.model,
          messages: [...(request.system ? [{ role: "system", content: request.system }] : []), { role: "user", content: request.prompt }],
          temperature: request.temperature,
          max_tokens: this.config.maxTokens,
          ...(this.config.reasoningEffort ? { reasoning_effort: this.config.reasoningEffort } : {}),
          ...(request.contract ? { response_format: { type: "json_object" } } : {})
        }),
        signal: AbortSignal.any(signals)
      });
    } catch (error) {
      throw new Error(`Nemotron endpoint ${base} unreachable: ${error instanceof Error ? (error.name === "TimeoutError" ? `timed out after ${request.timeoutMs} ms` : error.message) : error}`);
    }
    const text = await response.text();
    if (!response.ok) throw new Error(`Nemotron endpoint returned HTTP ${response.status}: ${text.slice(0, 300)}`);
    const body = JSON.parse(text);
    if (typeof body.model === "string") this.servedModels.add(body.model);
    const choice = body.choices?.[0];
    const content = typeof choice?.message?.content === "string" ? choice.message.content : "";
    if (!content.trim()) {
      throw new Error(`Nemotron returned no answer content (finish_reason ${choice?.finish_reason ?? "unknown"}, ${body.usage?.completion_tokens ?? "?"} completion tokens). Raise NEMOTRON_MAX_TOKENS or set NEMOTRON_REASONING_EFFORT=none.`);
    }
    return {
      text: content,
      ...(Number.isFinite(body.usage?.prompt_tokens) ? { inputTokens: body.usage.prompt_tokens } : {}),
      ...(Number.isFinite(body.usage?.completion_tokens) ? { outputTokens: body.usage.completion_tokens } : {})
    };
  }
}

// NVIDIA Nemotron as the reasoning model. Calls go through Speck's model
// registry, which validates the structured output against a contract,
// retries a malformed reply, and counts calls and failures. Any endpoint that
// speaks the OpenAI chat API works (NVIDIA's hosted API, a NIM, or a local
// Ollama). Decisive counter-examples stay with the deterministic rules; the
// model judges the rest.
export class NemotronReasoner implements Reasoner {
  readonly kind = "nemotron" as const;
  private readonly processor: NemotronProcessor;

  constructor(private readonly runtime: SpeckRuntime, private readonly config: NemotronConfig) {
    this.processor = new NemotronProcessor(config);
    if (!this.problem()) {
      const descriptor: ModelProcessorDescriptor = {
        id: NEMOTRON_PROCESSOR_ID, provider: "openai-compatible", model: config.model,
        tier: 2, contextSize: 32_768, specialties: ["reasoning"], enabled: true
      };
      runtime.registerModelProcessor(descriptor, this.processor);
    }
  }

  describe(): ReasonerDescription {
    const problem = this.problem();
    return {
      kind: this.kind, label: "NVIDIA Nemotron via OpenAI-compatible endpoint", provider: "openai-compatible",
      model: this.config.model || null, endpoint: this.config.baseUrl || null, ready: !problem, problem
    };
  }

  async assess(input: { chunkPrompt: string; batch: EvidenceRecord[]; hypotheses: HypothesisSpec[] }): Promise<BatchAssessment> {
    this.assertReady();
    const judgments: BatchAssessment["judgments"] = {};
    for (const record of input.batch) judgments[record.id] = ruleJudgments(record, input.hypotheses, { decisiveOnly: true });
    const notes: string[] = [];
    if (!input.batch.length) return { judgments, notes, narrative: "" };
    const ids = input.batch.map((record) => record.id);
    const keys = input.hypotheses.map((hypothesis) => hypothesis.key);
    const response = await this.runtime.modelRegistry.infer({
      processorId: NEMOTRON_PROCESSOR_ID,
      prompt: assessmentPrompt(input.chunkPrompt, input.batch, input.hypotheses),
      contract: relationsContract(ids, keys),
      temperature: 0.1,
      timeoutMs: this.config.timeoutMs,
      maxAttempts: 2
    });
    const structured = response.structured as { judgments: Array<Record<string, unknown>>; summary: string };
    for (const raw of structured.judgments) {
      const recordId = String(raw.evidence_id);
      // Models sometimes echo the whole "H-KEY: statement" line as the key.
      const named = String(raw.hypothesis);
      const key = keys.find((candidate) => named === candidate || named.startsWith(`${candidate}:`)) ?? named;
      const relation = String(raw.relation);
      if (!ids.includes(recordId) || !keys.includes(key)) {
        notes.push(`Discarded a model judgment about unknown ${!ids.includes(recordId) ? `evidence "${recordId}"` : `hypothesis "${key}"`}.`);
        continue;
      }
      if (relation === "neutral") continue;
      const existing = judgments[recordId]!.find((judgment) => judgment.hypothesisKey === key);
      if (existing) {
        if (existing.direction !== relation) {
          notes.push(existing.basis === "rule"
            ? `Model said ${recordId} ${relation} ${key}; kept the rule judgment (${existing.direction}${existing.decisive ? ", decisive" : ""}).`
            : `Model gave conflicting judgments on ${recordId} / ${key}; kept its first (${existing.direction}).`);
        }
        continue;
      }
      const strength = Number(raw.strength);
      judgments[recordId]!.push({
        hypothesisKey: key,
        direction: relation as "supports" | "contradicts",
        strength: Number.isFinite(strength) ? Math.min(1, Math.max(0.1, strength)) : 0.5,
        decisive: false,
        basis: "model",
        rationale: String(raw.rationale ?? "").slice(0, 400)
      });
    }
    const lines = input.batch.map((record) => describeJudgments(record, judgments[record.id]!));
    return { judgments, notes, narrative: [String(structured.summary ?? "").trim(), ...lines].filter(Boolean).join("\n") };
  }

  async explain(prompt: string): Promise<Explanation> {
    this.assertReady();
    const response = await this.runtime.modelRegistry.infer({
      processorId: NEMOTRON_PROCESSOR_ID, prompt, contract: explanationContract,
      temperature: 0.1, timeoutMs: this.config.timeoutMs, maxAttempts: 2
    });
    const structured = response.structured as { explanation: string; cited_evidence: unknown[]; stated_conclusion: string; stated_established: boolean };
    return {
      text: String(structured.explanation), citedEvidence: structured.cited_evidence.map(String),
      statedConclusion: String(structured.stated_conclusion).trim(), statedEstablished: structured.stated_established === true
    };
  }

  usage(): ReasonerUsage | null {
    const snapshot = this.runtime.modelRegistry.list().find((processor) => processor.id === NEMOTRON_PROCESSOR_ID);
    return snapshot
      ? {
          calls: snapshot.calls, successes: snapshot.successes, failures: snapshot.failures, lastError: snapshot.lastError,
          servedModels: [...this.processor.servedModels], httpCalls: [...this.processor.calls]
        }
      : null;
  }

  private problem(): string | null {
    if (!this.config.baseUrl) return "NEMOTRON_BASE_URL is not set";
    if (!this.config.model) return "NEMOTRON_MODEL is not set";
    if (!/nemotron/i.test(this.config.model)) return `NEMOTRON_MODEL "${this.config.model}" does not name a Nemotron model`;
    return null;
  }

  private assertReady(): void {
    const problem = this.problem();
    if (problem) throw new Error(`Nemotron reasoner is not configured: ${problem}. Set it in .env (see .env.example) or use REASONER=rules.`);
  }
}

function assessmentPrompt(chunkPrompt: string, batch: readonly EvidenceRecord[], hypotheses: readonly HypothesisSpec[]): string {
  return [
    chunkPrompt,
    "",
    "HYPOTHESES:",
    ...hypotheses.map((hypothesis) => `- ${hypothesis.key}: ${hypothesis.statement}`),
    "",
    "EVIDENCE IN THIS CHUNK:",
    ...batch.map((record) => [
      `[${record.id}] source: ${record.source.name}; observed ${record.observedAt}`,
      `  ${record.content}`,
      `  facts: ${Object.entries(record.facts).map(([key, value]) => `${key}=${value}`).join(", ") || "(none)"}`
    ].join("\n")),
    "",
    "For every evidence item and every hypothesis, say whether the item supports or contradicts the hypothesis, or is neutral.",
    "Judge only from the evidence text above. Do not assume facts that are not stated.",
    // An open-ended list let a small model repeat one pair until it ran out
    // of tokens (nemotron-3-nano:4b, 2026-10-22); a fixed list of pairs does not.
    `judgments has exactly ${batch.length * hypotheses.length} items, one per pair, in this order:`,
    ...batch.flatMap((record) => hypotheses.map((hypothesis) => `  (${record.id}, ${hypothesis.key})`)),
    // Speck's contract instruction names only the top-level keys, so the
    // fields of each judgment are spelled out here.
    "Each item of judgments is an object with exactly these fields:",
    `- evidence_id: one of ${batch.map((record) => JSON.stringify(record.id)).join(", ")}`,
    `- hypothesis: one of ${hypotheses.map((hypothesis) => JSON.stringify(hypothesis.key)).join(", ")} (the key only)`,
    "- relation: \"supports\", \"contradicts\" or \"neutral\"",
    "- strength: a number from 0.1 (weak) to 1 (strong)",
    "- rationale: one short sentence",
    "summary: one or two sentences on what this chunk changed."
  ].join("\n");
}

function relationsContract(ids: string[], keys: string[]): StructuredOutputContract {
  return {
    name: "evidence_relations",
    description: "How each evidence item bears on each hypothesis",
    required: ["judgments", "summary"],
    properties: {
      judgments: {
        type: "array",
        items: {
          type: "object",
          properties: {
            evidence_id: { type: "string", enum: ids },
            hypothesis: { type: "string", enum: keys },
            relation: { type: "string", enum: ["supports", "contradicts", "neutral"] },
            strength: { type: "number" },
            rationale: { type: "string" }
          },
          required: ["evidence_id", "hypothesis", "relation", "strength", "rationale"]
        }
      },
      summary: { type: "string" }
    }
  };
}

const explanationContract: StructuredOutputContract = {
  name: "investigation_explanation",
  description: "A short explanation of the current conclusion with the evidence ids it relies on",
  required: ["explanation", "cited_evidence", "stated_conclusion", "stated_established"],
  properties: {
    explanation: { type: "string" },
    cited_evidence: { type: "array", items: { type: "string" } },
    // The model's own declaration of what its text concludes, so agreement
    // with Speck's belief state can be checked without parsing prose.
    stated_conclusion: { type: "string" },
    stated_established: { type: "boolean" }
  }
};
