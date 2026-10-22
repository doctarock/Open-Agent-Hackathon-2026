import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, type AppConfig } from "../src/config.js";
import { EvidenceDesk } from "../src/investigation/desk.js";

// Tests read no .env and no process environment: every config starts from an
// empty environment, so nothing here can depend on a credential.

export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "evidence-desk-test-"));
}

export function testConfig(overrides: Partial<AppConfig> = {}, env: NodeJS.ProcessEnv = {}): AppConfig {
  const dir = tempDir();
  return loadConfig(env, { databasePath: path.join(dir, "desk.sqlite"), historyDir: path.join(dir, "meterless"), ...overrides });
}

export async function withDesk<T>(config: AppConfig, body: (desk: EvidenceDesk) => Promise<T>, options: Parameters<typeof EvidenceDesk.open>[1] = {}): Promise<T> {
  const desk = await EvidenceDesk.open(config, options);
  try {
    return await body(desk);
  } finally {
    desk.close();
  }
}

// A scenario written to a temp directory, for cases the shipped fixture does
// not cover.
export function writeScenario(scenario: unknown, records: unknown[]): string {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "scenario.json"), JSON.stringify(scenario));
  fs.writeFileSync(path.join(dir, "evidence.json"), JSON.stringify({ records }));
  return dir;
}
