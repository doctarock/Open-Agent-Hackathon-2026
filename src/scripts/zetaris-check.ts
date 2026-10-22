import { loadConfig, loadDotEnv } from "../config.js";
import { EvidenceProviderError } from "../evidence/types.js";
import { ZetarisEvidenceProvider } from "../evidence/zetaris-provider.js";
import { loadScenario } from "../scenario.js";

// Exercises the live Zetaris path regardless of EVIDENCE_MODE: login, a
// trivial SELECT, then the case's evidence from every configured table.

loadDotEnv();
const config = loadConfig();
const provider = new ZetarisEvidenceProvider(config.zetaris);
const caseId = loadScenario(config.scenarioDir).caseId;
try {
  console.log(`Zetaris at ${config.zetaris.baseUrl} as ${config.zetaris.username || "(no user set)"}`);
  const probe = await provider.select("SELECT 1 AS ok", "connectivity probe");
  console.log(`  connectivity probe: ${JSON.stringify(probe.records)}`);
  const records = await provider.fetchCaseEvidence(caseId);
  const byTable = new Map<string, number>();
  for (const record of records) byTable.set(record.retrieval.location, (byTable.get(record.retrieval.location) ?? 0) + 1);
  for (const [table, count] of byTable) console.log(`  ${table}: ${count} record(s) for ${caseId}`);
  console.log(`  ${records.length} record(s) retrieved via Zetaris.`);
} catch (error) {
  if (error instanceof EvidenceProviderError) {
    console.error(`FAILED: ${error.message}\n  what to do: ${error.hint}${error.detail ? `\n  server said: ${error.detail}` : ""}`);
    process.exit(1);
  }
  throw error;
}
