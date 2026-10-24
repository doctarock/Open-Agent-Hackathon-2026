import fs from "node:fs";
import path from "node:path";
import { byObservation, validateEvidenceRecord, type EvidenceFetch, type EvidenceProvider, type ProviderDescription } from "./types.js";

// Evidence from the scenario's fixture file, for tests and local development.
// Every record is labelled as fixture data.
// Why fixtures exist at all: the whole pipeline (Speck, the Meterless engine,
// the reasoning, the trace) can then be run and tested with no credentials or
// network. Why they are labelled so plainly: the page, every record and the
// trace say FIXTURE, so a fixture run is never mistaken for a Zetaris one.
export class FixtureEvidenceProvider implements EvidenceProvider {
  readonly mode = "fixture" as const;

  // label: how the page names this source (evidence a person entered, say).
  constructor(private readonly file: string, private readonly rootDir: string, private readonly label = "Local fixtures (not Zetaris)") {}

  describe(): ProviderDescription {
    const exists = fs.existsSync(this.file);
    return {
      mode: this.mode,
      label: this.label,
      target: this.relative(),
      ready: exists,
      problem: exists ? null : `fixture file ${this.relative()} does not exist`
    };
  }

  // The summary names the file read. No Zetaris query is involved.
  async fetchCaseEvidence(caseId: string): Promise<EvidenceFetch> {
    const document = JSON.parse(fs.readFileSync(this.file, "utf8")) as { records?: unknown[] };
    const retrievedAt = new Date().toISOString();
    const records = (document.records ?? [])
      .map((value, index) => validateEvidenceRecord(value, `${this.relative()} record ${index}`))
      .filter((record) => record.caseId === caseId)
      .map((record) => ({ ...record, retrieval: { mode: this.mode, location: this.relative(), retrievedAt } }))
      .sort(byObservation);
    return { records, summary: { mode: this.mode, at: retrievedAt, sources: [{ location: this.relative(), rows: records.length, queryToken: null, latencyMs: null }] } };
  }

  private relative(): string {
    return path.relative(this.rootDir, this.file).split(path.sep).join("/");
  }
}
