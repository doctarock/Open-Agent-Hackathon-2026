import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, loadDotEnv, ROOT_DIR } from "../config.js";
import { validateEvidenceRecord } from "../evidence/types.js";
import type { ZetarisQueryConfig } from "../evidence/zetaris-provider.js";

// Loads the scenario's evidence into a LOCAL Zetaris platform (the Docker
// Compose bundle) as one Lightning file-store table per source system, using
// the platform's documented DDL (CREATE LIGHTNING DATABASE / FILESTORE TABLE,
// as in its seed-org.sql). Live mode then reads the evidence back through
// Zetaris. The content originates from this repository's fixture file; the
// seed exists so the live path can be exercised end to end.
//
// Needs: docker on PATH, the platform running, ZETARIS_USERNAME/PASSWORD.
// ZETARIS_DRIVER_CONTAINER overrides the driver container name.

loadDotEnv();
const config = loadConfig();
// The per-source tables this script creates, whatever ZETARIS_QUERY_CONFIG
// selects for reading (the default reads the USL built on top by npm run zetaris:usl).
const queries = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "config", "zetaris-queries.json"), "utf8")) as Required<Pick<ZetarisQueryConfig, "database" | "sources">>;
const container = process.env.ZETARIS_DRIVER_CONTAINER?.trim() || "zetaris-driver-1";
const remoteRoot = "/home/zetaris/customer-data/shared/evidence_desk";

if (!config.zetaris.username || !config.zetaris.password) {
  console.error("Set ZETARIS_USERNAME and ZETARIS_PASSWORD (see .env.example).");
  process.exit(1);
}

const evidence = JSON.parse(fs.readFileSync(path.join(config.scenarioDir, "evidence.json"), "utf8")) as { records: unknown[] };
const records = evidence.records.map((record, index) => validateEvidenceRecord(record, `evidence.json record ${index}`));
const staging = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-desk-seed-"));

const login = await fetch(`${config.zetaris.baseUrl}/api/auth/login`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: config.zetaris.username, password: config.zetaris.password })
});
const session = await login.json().catch(() => ({})) as { idToken?: string; orgId?: number };
if (!login.ok || !session.idToken) {
  console.error(`Zetaris login failed (HTTP ${login.status}). Check ZETARIS_USERNAME / ZETARIS_PASSWORD and that the platform is up.`);
  process.exit(1);
}
const orgId = config.zetaris.orgId ?? String(session.orgId);

async function statement(sql: string, tolerate?: RegExp): Promise<void> {
  // The SQL-editor route: the query/sql/start route accepts SELECT only.
  const response = await fetch(`${config.zetaris.baseUrl}/api/proxy/sql-editor/sqls/run-query`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${session.idToken}`, "x-org-id": orgId, "x-request-id": randomUUID() },
    body: JSON.stringify({ sql })
  });
  const body = await response.json().catch(() => ({})) as { msg?: string };
  if (!response.ok || body.msg) {
    if (tolerate && tolerate.test(body.msg ?? "")) { console.log(`  (already present) ${sql.split("\n")[0]}`); return; }
    throw new Error(`Zetaris rejected: ${sql.split("\n")[0]}\n${(body.msg ?? `HTTP ${response.status}`).slice(0, 400)}`);
  }
  console.log(`  ok ${sql.split("\n")[0]}`);
}

console.log(`Staging NDJSON in ${staging} and copying it into ${container}:${remoteRoot}`);
execFileSync("docker", ["exec", container, "mkdir", "-p", remoteRoot], { stdio: "inherit" });
for (const source of queries.sources) {
  const name = source.table.split(".")[1]!;
  const rows = records.filter((record) => record.source.system === source.system).map((record) => JSON.stringify({
    id: record.id, case_id: record.caseId, source_system: record.source.system, source_name: record.source.name,
    observed_at: record.observedAt, content: record.content, facts_json: JSON.stringify(record.facts),
    record_ref: record.provenance.recordRef, system_of_record: record.provenance.systemOfRecord,
    author: record.provenance.author, supersedes: record.provenance.supersedes.join(",")
  }));
  const local = path.join(staging, name);
  fs.mkdirSync(local);
  // One file per row: Lightning's JSON file store reads only the first object
  // of a newline-delimited file (observed on the local bundle, 2026-10-22).
  rows.forEach((row, index) => fs.writeFileSync(path.join(local, `part-${index}.json`), `${row}\n`));
  execFileSync("docker", ["exec", "-u", "0", container, "rm", "-rf", `${remoteRoot}/${name}`], { stdio: "inherit" });
  execFileSync("docker", ["cp", local, `${container}:${remoteRoot}/${name}`], { stdio: "inherit" });
  console.log(`  ${source.table}: ${rows.length} row(s) from source "${source.system}"`);
}
execFileSync("docker", ["exec", "-u", "0", container, "chmod", "-R", "a+rX", remoteRoot], { stdio: "inherit" });
fs.rmSync(staging, { recursive: true, force: true });

console.log("Registering tables in Zetaris:");
await statement(`CREATE LIGHTNING DATABASE ${queries.database} DESCRIBE BY "Evidence Desk scenario evidence" OPTIONS ()`, /already exists/i);
for (const source of queries.sources) {
  const [database, name] = source.table.split(".");
  await statement(`CREATE LIGHTNING FILESTORE TABLE ${name} FROM ${database} FORMAT json OPTIONS (path "file://${remoteRoot}/${name}")`, /already exists/i);
}
console.log("Done. Check the live path with `npm run zetaris:check`.");
