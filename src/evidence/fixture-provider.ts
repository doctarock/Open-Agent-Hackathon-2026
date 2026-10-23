import fs from "node:fs";
import path from "node:path";
import { byObservation, validateEvidenceRecord, type EvidenceProvider, type EvidenceRecord, type FetchSummary, type ProviderDescription } from "./types.js";

// Evidence from the scenario's fixture file, for tests and local development.
// Every record is labelled as fixture data.
export class FixtureEvidenceProvider implements EvidenceProvider {
  readonly mode = "fixture" as const;
  private fetched: FetchSummary | null = null;

  constructor(private readonly file: string, private readonly rootDir: string) {}

  describe(): ProviderDescription {
    const exists = fs.existsSync(this.file);
    return {
      mode: this.mode,
      label: "Local fixtures (not Zetaris)",
      target: this.relative(),
      ready: exists,
      problem: exists ? null : `fixture file ${this.relative()} does not exist`
    };
  }

  async fetchCaseEvidence(caseId: string): Promise<EvidenceRecord[]> {
    const document = JSON.parse(fs.readFileSync(this.file, "utf8")) as { records?: unknown[] };
    const retrievedAt = new Date().toISOString();
    const records = (document.records ?? [])
      .map((value, index) => validateEvidenceRecord(value, `${this.relative()} record ${index}`))
      .filter((record) => record.caseId === caseId)
      .map((record) => ({ ...record, retrieval: { mode: this.mode, location: this.relative(), retrievedAt } }))
      .sort(byObservation);
    this.fetched = { mode: this.mode, at: retrievedAt, sources: [{ location: this.relative(), rows: records.length, queryToken: null, latencyMs: null }] };
    return records;
  }

  // The file read by the last fetch. No Zetaris query is involved.
  lastFetch(): FetchSummary | null {
    return this.fetched;
  }

  private relative(): string {
    return path.relative(this.rootDir, this.file).split(path.sep).join("/");
  }
}
