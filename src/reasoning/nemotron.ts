import { ModelRegistry, type ModelProcessor, type ModelProcessorDescriptor, type ModelRequest, type ProcessorCompletion, type SpeckRuntime, type StructuredOutputContract } from "#speck";
import type { NemotronConfig } from "../config.js";
import type { EvidenceRecord } from "../evidence/types.js";
import type { HypothesisSpec } from "../scenario.js";
import { isMeterlessModel, meterlessHeaders, METERLESS_NAME } from "./meterless.js";
import { describeJudgments, ruleJudgments } from "./rules.js";
import type { BatchAssessment, Explanation, ModelCallTrace, Reasoner, ReasonerDescription, ReasonerUsage, RelationJudgment } from "./types.js";

export const NEMOTRON_PROCESSOR_ID = "nemotron";
// How every structured call is made: low temperature, and at most two
// attempts through Speck's registry (a reply that fails its contract is retried once).
const TEMPERATURE = 0.1;
const MAX_ATTEMPTS = 2;

// Where a chat completion goes and what it carries, for every provider.
export function chatEndpoint(config: NemotronConfig): { url: string; headers: Record<string, string> } {
  const base = config.baseUrl.replace(/\/+$/, "");
  const auth: Record<string, string> = config.provider === "meterless"
    ? meterlessHeaders(config.apiKey, { chat: true })
    : config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {};
  return { url: `${base}${base.endsWith("/v1") ? "" : "/v1"}/chat/completions`, headers: { "content-type": "application/json", ...auth } };
}

export function providerLabel(config: NemotronConfig): string {
  return config.provider === "meterless" ? METERLESS_NAME
    : config.provider === "ollama" ? "Nemotron on local Ollama"
      : config.provider === "nvidia" ? "Nemotron on NVIDIA's hosted API"
        : "Nemotron via OpenAI-compatible endpoint";
}

// What stops the assessor running with these settings, or null.
export function modelConfigProblem(config: NemotronConfig): string | null {
  if (!config.baseUrl) return "NEMOTRON_BASE_URL is not set";
  if (config.provider === "meterless") {
    if (!isMeterlessModel(config.model)) return `METERLESS_MODEL "${config.model}" is not a Meterless routing mode (meterless/...)`;
    if (!config.apiKey) return `${config.apiKeyEnv} is not set (the runtime writes its token to <stateDir>/proxy-token; run npm run configure)`;
    return null;
  }
  if (!config.model) return "NEMOTRON_MODEL is not set";
  if (!/nemotron/i.test(config.model)) return `NEMOTRON_MODEL "${config.model}" does not name a Nemotron model`;
  if (config.provider === "nvidia" && !config.apiKey) return `${config.apiKeyEnv} is not set (NVIDIA's hosted API needs a key)`;
  return null;
}

// One plain-text chat completion ("Reply with the single word: ready"), as
// npm run model:check and npm run configure make it. Throws with the
// endpoint's own words on any failure, including content that is not a string.
export async function plainTextCheck(config: NemotronConfig): Promise<{ url: string; content: string; served: string | null; latencyMs: number; usage: unknown }> {
  const { url, headers } = chatEndpoint(config);
  const began = performance.now();
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: config.model, temperature: 0, max_tokens: config.maxTokens,
        ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
        messages: [{ role: "user", content: "Reply with the single word: ready" }]
      }),
      signal: AbortSignal.timeout(config.timeoutMs)
    });
  } catch (error) {
    throw new Error(`${url} unreachable: ${error instanceof Error ? error.message : error}`);
  }
  const body = await response.json().catch(() => ({})) as any;
  if (!response.ok) {
    const hint = response.status === 401 || response.status === 403 ? ` Is ${config.apiKeyEnv} set to a valid key?` : "";
    throw new Error(`HTTP ${response.status} from ${url}: ${JSON.stringify(body).slice(0, 400)}.${hint}`);
  }
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error(`the reply's content is ${content === undefined ? "missing" : typeof content}, not a string`);
  return { url, content, served: typeof body.model === "string" ? body.model : null, latencyMs: Math.round(performance.now() - began), usage: body.usage ?? null };
}

// One OpenAI-compatible chat completion against the Nemotron endpoint,
// plugged into Speck's model registry. Speck's built-in processor caps output
// at 1024 tokens and cannot turn reasoning off, and a Nemotron reasoning
// trace alone can fill that cap (measured: 935 tokens on a short prompt), so
// this processor sends the configured reasoning effort and output budget. It
// records the model name the endpoint reports serving.
export class NemotronProcessor implements ModelProcessor {
  readonly servedModels = new Set<string>();
  // Every HTTP call as measured here: wall-clock latency, whether the
  // endpoint returned answer content (contract validity is judged later), and
  // the model name the response reported.
  readonly calls: Array<{ latencyMs: number; answered: boolean; servedModel: string | null }> = [];
  private lastServed: string | null = null;

  constructor(private readonly config: NemotronConfig) {}

  async infer(request: ModelRequest): Promise<ProcessorCompletion> {
    const began = performance.now();
    this.lastServed = null;
    try {
      const completion = await this.complete(request);
      this.calls.push({ latencyMs: Math.round(performance.now() - began), answered: true, servedModel: this.lastServed });
      return completion;
    } catch (error) {
      this.calls.push({ latencyMs: Math.round(performance.now() - began), answered: false, servedModel: this.lastServed });
      throw error;
    }
  }

  private async complete(request: ModelRequest): Promise<ProcessorCompletion> {
    const base = this.config.baseUrl.replace(/\/+$/, "");
    const endpoint = chatEndpoint(this.config);
    const name = this.config.provider === "meterless" ? METERLESS_NAME : "Nemotron endpoint";
    const signals = [AbortSignal.timeout(request.timeoutMs), ...(request.signal ? [request.signal] : [])];
    let response: Response;
    try {
      response = await fetch(endpoint.url, {
        method: "POST",
        headers: endpoint.headers,
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
      throw new Error(`${name} ${base} unreachable: ${error instanceof Error ? (error.name === "TimeoutError" ? `timed out after ${request.timeoutMs} ms` : error.message) : error}`);
    }
    const text = await response.text();
    if (!response.ok) {
      const hint = response.status === 401 || response.status === 403 ? ` (unauthorized: check ${this.config.apiKeyEnv})` : "";
      throw new Error(`${name} returned HTTP ${response.status}${hint}: ${text.slice(0, 300)}`);
    }
    const body = JSON.parse(text);
    if (typeof body.model === "string") { this.servedModels.add(body.model); this.lastServed = body.model; }
    const choice = body.choices?.[0];
    const content = typeof choice?.message?.content === "string" ? choice.message.content : "";
    if (!content.trim()) {
      throw new Error(`${name} returned no answer content (finish_reason ${choice?.finish_reason ?? "unknown"}, ${body.usage?.completion_tokens ?? "?"} completion tokens). Raise NEMOTRON_MAX_TOKENS or set NEMOTRON_REASONING_EFFORT=none.`);
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
  // Speck's model registry class, privately: Speck's contract validation and
  // retries apply to every call, but the model is not added to the Speck
  // runtime's own registry, where Speck's other components (its chat, for
  // one) could select it. That matters when Evidence Desk runs inside Speck.
  private readonly registry = new ModelRegistry();
  private lastTrace: ModelCallTrace | null = null;

  constructor(_runtime: SpeckRuntime, private readonly config: NemotronConfig) {
    this.processor = new NemotronProcessor(config);
    if (!this.problem()) {
      const descriptor: ModelProcessorDescriptor = {
        id: NEMOTRON_PROCESSOR_ID, provider: "openai-compatible", model: config.model,
        tier: 2, contextSize: 32_768, specialties: ["reasoning"], enabled: true
      };
      this.registry.register(descriptor, this.processor);
    }
  }

  describe(): ReasonerDescription {
    const problem = this.problem();
    return {
      kind: this.kind, label: providerLabel(this.config), provider: this.config.provider,
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
    const contract = relationsContract(ids, keys);
    const trace = this.beginTrace("relation-judgments", contract.name, ids.length * keys.length);
    let response;
    try {
      response = await this.registry.infer({
        processorId: NEMOTRON_PROCESSOR_ID,
        prompt: assessmentPrompt(input.chunkPrompt, input.batch, input.hypotheses),
        contract,
        temperature: TEMPERATURE,
        timeoutMs: this.config.timeoutMs,
        maxAttempts: MAX_ATTEMPTS
      });
    } catch (error) {
      this.lastTrace = trace.end("failed", error);
      throw error;
    }
    const structured = response.structured as { judgments: Array<Record<string, unknown>>; summary: string };
    const counts = { returned: structured.judgments.length, neutral: 0, kept: 0, discardedUnknown: 0, ruleKept: 0, repeated: 0 };
    const answered = new Set<string>();
    for (const raw of structured.judgments) {
      const recordId = String(raw.evidence_id);
      // Models sometimes echo the whole "H-KEY: statement" line as the key.
      const named = String(raw.hypothesis);
      const key = keys.find((candidate) => named === candidate || named.startsWith(`${candidate}:`)) ?? named;
      const relation = String(raw.relation);
      if (!ids.includes(recordId) || !keys.includes(key)) {
        counts.discardedUnknown += 1;
        notes.push(`Discarded a model judgment about unknown ${!ids.includes(recordId) ? `evidence "${recordId}"` : `hypothesis "${key}"`}.`);
        continue;
      }
      answered.add(recordId);
      if (relation === "neutral") { counts.neutral += 1; continue; }
      const existing = judgments[recordId]!.find((judgment) => judgment.hypothesisKey === key);
      if (existing) {
        if (existing.direction !== relation && existing.basis === "rule") counts.ruleKept += 1;
        else counts.repeated += 1;
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
      counts.kept += 1;
    }
    // A record the model said nothing about (not even "neutral") is left
    // unjudged rather than passed off as having no bearing; the desk keeps it
    // pending for the next run.
    const unanswered: string[] = [];
    for (const id of ids) {
      if (answered.has(id)) continue;
      delete judgments[id];
      unanswered.push(id);
      notes.push(`The model returned no judgment for ${id}.`);
    }
    this.lastTrace = { ...trace.end("valid", null), judgments: { ...counts, unanswered } };
    const lines = input.batch.filter((record) => judgments[record.id]).map((record) => describeJudgments(record, judgments[record.id]!));
    return { judgments, notes, narrative: [String(structured.summary ?? "").trim(), ...lines].filter(Boolean).join("\n") };
  }

  async explain(prompt: string): Promise<Explanation> {
    this.assertReady();
    const trace = this.beginTrace("explanation", explanationContract.name, 0);
    let response;
    try {
      response = await this.registry.infer({
        processorId: NEMOTRON_PROCESSOR_ID, prompt, contract: explanationContract,
        temperature: TEMPERATURE, timeoutMs: this.config.timeoutMs, maxAttempts: MAX_ATTEMPTS
      });
    } catch (error) {
      this.lastTrace = trace.end("failed", error);
      throw error;
    }
    this.lastTrace = trace.end("valid", null);
    const structured = response.structured as { explanation: string; cited_evidence: unknown[]; stated_conclusion: string; stated_established: boolean };
    return {
      text: String(structured.explanation), citedEvidence: structured.cited_evidence.map(String),
      statedConclusion: String(structured.stated_conclusion).trim(), statedEstablished: structured.stated_established === true
    };
  }

  takeTrace(): ModelCallTrace | null {
    const trace = this.lastTrace;
    this.lastTrace = null;
    return trace;
  }

  // Measures one call: Speck's registry counters and this processor's HTTP
  // calls before and after it, so retries and contract rejections are the
  // registry's own counts for this call alone.
  private beginTrace(purpose: ModelCallTrace["purpose"], contract: string, requiredPairs: number) {
    const before = this.registrySnapshot();
    const firstCall = this.processor.calls.length;
    return {
      end: (outcome: ModelCallTrace["outcome"], error: unknown): ModelCallTrace => {
        const after = this.registrySnapshot();
        const calls = this.processor.calls.slice(firstCall);
        return {
          purpose, processor: NEMOTRON_PROCESSOR_ID, requestedModel: this.config.model, endpoint: this.config.baseUrl,
          servedModels: [...new Set(calls.flatMap((call) => (call.servedModel ? [call.servedModel] : [])))],
          constraints: {
            contract, requiredPairs, temperature: TEMPERATURE, maxAttempts: MAX_ATTEMPTS,
            maxTokens: this.config.maxTokens, reasoningEffort: this.config.reasoningEffort || null
          },
          attempts: after.calls - before.calls,
          contractFailures: after.contractFailures - before.contractFailures,
          transportFailures: after.transportFailures - before.transportFailures,
          httpCalls: calls.map((call) => ({ latencyMs: call.latencyMs, answered: call.answered })),
          outcome,
          error: error === null ? null : error instanceof Error ? error.message : String(error)
        };
      }
    };
  }

  private registrySnapshot(): { calls: number; contractFailures: number; transportFailures: number } {
    const snapshot = this.registry.list().find((processor) => processor.id === NEMOTRON_PROCESSOR_ID);
    return { calls: snapshot?.calls ?? 0, contractFailures: snapshot?.contractFailures ?? 0, transportFailures: snapshot?.transportFailures ?? 0 };
  }

  usage(): ReasonerUsage | null {
    const snapshot = this.registry.list().find((processor) => processor.id === NEMOTRON_PROCESSOR_ID);
    return snapshot
      ? {
          calls: snapshot.calls, successes: snapshot.successes, failures: snapshot.failures, lastError: snapshot.lastError,
          servedModels: [...this.processor.servedModels], httpCalls: this.processor.calls.map((call) => ({ latencyMs: call.latencyMs, answered: call.answered }))
        }
      : null;
  }

  private problem(): string | null {
    return modelConfigProblem(this.config);
  }

  private assertReady(): void {
    const problem = this.problem();
    if (problem) throw new Error(`The model assessor is not configured: ${problem}. Run npm run configure, set it in .env (see .env.example), or use REASONER=rules.`);
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
