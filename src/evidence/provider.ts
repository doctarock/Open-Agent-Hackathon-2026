import path from "node:path";
import type { AppConfig } from "../config.js";
import { FixtureEvidenceProvider } from "./fixture-provider.js";
import type { EvidenceProvider } from "./types.js";
import { ZetarisEvidenceProvider } from "./zetaris-provider.js";

// The mode is chosen explicitly by EVIDENCE_MODE. There is no fallback from
// one to the other.
export function createEvidenceProvider(config: AppConfig, fetchImpl: typeof fetch = fetch): EvidenceProvider {
  return config.evidenceMode === "zetaris"
    ? new ZetarisEvidenceProvider(config.zetaris, fetchImpl)
    : new FixtureEvidenceProvider(path.join(config.scenarioDir, "evidence.json"), config.rootDir);
}
