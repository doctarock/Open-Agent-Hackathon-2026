// Evidence records and the provider interface. A record always says where it
// came from twice over: its source system (provenance) and how this
// application retrieved it (retrieval), so fixture data can never pass as a
// live Zetaris result.
//
// Why it is built this way:
// - Provenance is the source's, retrieval is ours. "Which system recorded
//   this, and who wrote it" is a fact about the evidence; "did we read it from
//   Zetaris or from a file" is a fact about this run. Keeping both on every
//   record lets the page and the trace show each one without guessing.
// - Corrections are stated by the source. provenance.supersedes is the only
//   way one record replaces another (basis.ts); nothing infers it.
// - Records are validated where they enter. Every provider passes everything
//   it returns through validateEvidenceRecord, so a malformed fixture or table
//   row fails loudly instead of being half-used by the reasoning.

export type RetrievalMode = "fixture" | "zetaris";

export interface RetrievalOrigin {
  mode: RetrievalMode;
  // The fixture file, or the Zetaris table queried.
  location: string;
  retrievedAt: string;
  // Zetaris's own token for the query that returned the record.
  queryToken?: string;
}

export interface EvidenceRecord {
  id: string;
  caseId: string;
  source: { system: string; name: string };
  observedAt: string;
  content: string;
  facts: Record<string, string>;
  provenance: {
    systemOfRecord: string;
    recordRef: string;
    author: string;
    // Earlier records this one amends or replaces, as stated by the source.
    supersedes: string[];
  };
  retrieval: RetrievalOrigin;
}

export interface ProviderDescription {
  mode: RetrievalMode;
  label: string;
  // Where data comes from: the fixture path or the Zetaris base URL.
  target: string;
  ready: boolean;
  problem: string | null;
}

// What a fetch actually did: for Zetaris, each SELECT sent
// through the platform with its row count and query token (including tables
// that returned nothing); for fixtures, the file read.
export interface FetchSummary {
  mode: RetrievalMode;
  at: string;
  sources: Array<{ location: string; rows: number; queryToken: string | null; latencyMs: number | null }>;
}

// A fetch's records, with what the fetch did. Returned together, so a
// caller's summary is always its own fetch's, whatever else fetched meanwhile.
export interface EvidenceFetch {
  records: EvidenceRecord[];
  summary: FetchSummary;
}

export interface EvidenceProvider {
  readonly mode: RetrievalMode;
  describe(): ProviderDescription;
  fetchCaseEvidence(caseId: string): Promise<EvidenceFetch>;
}

export class EvidenceProviderError extends Error {
  constructor(message: string, readonly mode: RetrievalMode, readonly hint: string, readonly detail: string | null = null) {
    super(message);
    this.name = "EvidenceProviderError";
  }
}

type UnvalidatedRecord = Omit<EvidenceRecord, "retrieval">;

// Checks one record's shape. Providers call it on everything they return, so
// a malformed fixture or table row fails loudly instead of being half-used.
export function validateEvidenceRecord(value: unknown, where: string): UnvalidatedRecord {
  const fail = (message: string): never => { throw new TypeError(`${where}: ${message}`); };
  if (!value || typeof value !== "object") return fail("record must be an object");
  const record = value as Record<string, any>;
  for (const field of ["id", "caseId", "observedAt", "content"]) {
    if (typeof record[field] !== "string" || !record[field].trim()) fail(`${field} is required`);
  }
  if (Number.isNaN(Date.parse(record.observedAt))) fail(`observedAt "${record.observedAt}" is not a date`);
  if (typeof record.source?.system !== "string" || !record.source.system) fail("source.system is required");
  if (typeof record.source?.name !== "string" || !record.source.name) fail("source.name is required");
  const facts = record.facts ?? {};
  if (typeof facts !== "object" || Array.isArray(facts)) fail("facts must be an object");
  for (const [key, fact] of Object.entries(facts)) if (typeof fact !== "string") fail(`fact ${key} must be a string`);
  const provenance = record.provenance ?? {};
  for (const field of ["systemOfRecord", "recordRef", "author"]) {
    if (typeof provenance[field] !== "string" || !provenance[field]) fail(`provenance.${field} is required`);
  }
  const supersedes = provenance.supersedes ?? [];
  if (!Array.isArray(supersedes) || supersedes.some((id: unknown) => typeof id !== "string")) fail("provenance.supersedes must be a list of ids");
  return {
    id: record.id, caseId: record.caseId,
    source: { system: record.source.system, name: record.source.name },
    observedAt: new Date(record.observedAt).toISOString(),
    content: record.content,
    facts: { ...facts },
    provenance: {
      systemOfRecord: provenance.systemOfRecord, recordRef: provenance.recordRef,
      author: provenance.author, supersedes: [...supersedes]
    }
  };
}

// Observation time, then record id. Why the tie-break: two records observed at
// the same instant still have one fixed order, so every replay of the same
// evidence applies it in the same sequence and reaches the same beliefs.
export function byObservation(left: EvidenceRecord, right: EvidenceRecord): number {
  return left.observedAt.localeCompare(right.observedAt) || left.id.localeCompare(right.id);
}
