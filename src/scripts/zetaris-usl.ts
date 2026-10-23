import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, loadDotEnv, ROOT_DIR } from "../config.js";
import { ZetarisEvidenceProvider } from "../evidence/zetaris-provider.js";

// npm run zetaris:usl
//
// The Zetaris Unified Semantic Layer demonstration (zetaris/usl/README.md),
// against the local platform. Every statement is one the platform's own web
// interface issues, sent through the same route (POST
// /api/proxy/sql-editor/sqls/run-query). It leaves the live evidence path
// (Lightning database EVIDENCE_DESK) untouched: everything here lives in
// EVIDENCE_DESK_SOURCES, EVIDENCE_DESK_DQ_SAMPLE and the USL namespaces
// lightning.metastore.evidence_desk and lightning.metastore.evidence_desk_dq_sample.
//
// Steps: onboard two sources, query them, compile and activate the USL, query
// it, check it against the sources and the scenario, register and run the
// data-quality rule (clean on the real records; one failure on the isolated
// sample), and read the USL through Evidence Desk's own Zetaris adapter.
// Writes eval/results/zetaris-usl.{json,md} (git-ignored).

const USL_DIR = path.join(ROOT_DIR, "zetaris", "usl");
const REMOTE = "/home/zetaris/customer-data/shared/evidence_desk_usl";
const SOURCES_DB = "EVIDENCE_DESK_SOURCES";
const SAMPLE_DB = "EVIDENCE_DESK_DQ_SAMPLE";
const USL = "lightning.metastore.evidence_desk.delivery_usl";
const SAMPLE_USL = "lightning.metastore.evidence_desk_dq_sample.delivery_usl_dq_sample";
const RULE = "`evidence_id_present`";
const RULE_EXPRESSION = "evidence_id IS NOT NULL AND length(trim(evidence_id)) > 0";
const SHIPMENT = "PCL-88412";
const ALREADY = /already exists|DataQualityDuplicatedException/i;

interface Result { headers: string[]; data: string[][]; ms: number }
interface Step { title: string; sql: string; outcome: "ok" | "already present" | "error"; ms: number; headers?: string[]; rows?: string[][]; error?: string }

loadDotEnv();
const config = loadConfig();
const container = process.env.ZETARIS_DRIVER_CONTAINER?.trim() || "zetaris-driver-1";
if (!config.zetaris.username || !config.zetaris.password) {
  console.error("Set ZETARIS_USERNAME and ZETARIS_PASSWORD (see .env.example).");
  process.exit(1);
}

const login = await fetch(`${config.zetaris.baseUrl}/api/auth/login`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: config.zetaris.username, password: config.zetaris.password })
});
const session = await login.json().catch(() => ({})) as { idToken?: string; orgId?: number };
if (!login.ok || !session.idToken) {
  console.error(`Zetaris login failed (HTTP ${login.status}). Is the platform up (./verify.sh)?`);
  process.exit(1);
}
const orgId = config.zetaris.orgId ?? String(session.orgId);
const steps: Step[] = [];

async function run(sql: string): Promise<Result> {
  const began = performance.now();
  const response = await fetch(`${config.zetaris.baseUrl}/api/proxy/sql-editor/sqls/run-query`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${session.idToken}`, "x-org-id": orgId, "x-request-id": randomUUID() },
    body: JSON.stringify({ sql })
  });
  const body = await response.json().catch(() => ({})) as { headers?: string[]; data?: unknown[][]; msg?: string; message?: string };
  const ms = Math.round(performance.now() - began);
  if (!response.ok || body.msg || body.message) throw Object.assign(new Error(String(body.msg ?? body.message ?? `HTTP ${response.status}`)), { ms });
  return { headers: body.headers ?? [], data: (body.data ?? []).map((row) => row.map((value) => (value === null ? "null" : String(value)))), ms };
}

async function step(title: string, sql: string, options: { tolerate?: boolean } = {}): Promise<Result | null> {
  try {
    const result = await run(sql);
    steps.push({ title, sql, outcome: "ok", ms: result.ms, headers: result.headers, rows: result.data });
    console.log(`  ok   ${title} (${result.ms} ms${result.data.length ? `, ${result.data.length} row(s)` : ""})`);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const ms = (error as { ms?: number }).ms ?? 0;
    if (options.tolerate && ALREADY.test(message)) {
      steps.push({ title, sql, outcome: "already present", ms });
      console.log(`  --   ${title} (already present)`);
      return null;
    }
    steps.push({ title, sql, outcome: "error", ms, error: message.slice(0, 2000) });
    throw new Error(`${title} failed: ${message.split("\n")[0]}`);
  }
}

const sqlFile = (name: string) => fs.readFileSync(path.join(USL_DIR, name), "utf8").trim();

// 1-2. Identify and onboard: copy the source files into the driver's data
// folder and register them as Lightning file-store tables (the same
// onboarding the platform documents for files, and that npm run zetaris:seed uses).
console.log("Onboarding sources");
execFileSync("docker", ["exec", "-u", "0", container, "sh", "-c", `rm -rf ${REMOTE} && mkdir -p ${REMOTE}`], { stdio: "inherit" });
for (const [local, remote] of [["sources/wms_handover", "wms_handover"], ["sources/carrier_tracking", "carrier_tracking"], ["dq-sample/carrier_tracking_dq_sample", "carrier_tracking_dq_sample"]] as const) {
  execFileSync("docker", ["cp", path.join(USL_DIR, local), `${container}:${REMOTE}/${remote}`], { stdio: "inherit" });
}
execFileSync("docker", ["exec", "-u", "0", container, "chmod", "-R", "a+rX", REMOTE], { stdio: "inherit" });
await step("Create Lightning database for the sources", `CREATE LIGHTNING DATABASE ${SOURCES_DB} DESCRIBE BY "SAMPLE DATA - Evidence Desk delivery sources in native formats" OPTIONS ()`, { tolerate: true });
await step("Onboard warehouse handover export (CSV)", `CREATE LIGHTNING FILESTORE TABLE wms_handover FROM ${SOURCES_DB} FORMAT csv OPTIONS (path "file://${REMOTE}/wms_handover", header "true")`, { tolerate: true });
await step("Onboard carrier tracking feed (JSON)", `CREATE LIGHTNING FILESTORE TABLE carrier_tracking FROM ${SOURCES_DB} FORMAT json OPTIONS (path "file://${REMOTE}/carrier_tracking")`, { tolerate: true });

// 3. Query the sources.
console.log("Querying sources");
await step("Describe wms_handover", `DESC TABLE ${SOURCES_DB}.wms_handover`);
await step("Describe carrier_tracking", `DESC TABLE ${SOURCES_DB}.carrier_tracking`);
const wmsCount = await step("Count wms_handover", `SELECT count(*) AS records FROM ${SOURCES_DB}.wms_handover`);
const carrierCount = await step("Count carrier_tracking", `SELECT count(*) AS records FROM ${SOURCES_DB}.carrier_tracking`);
const wms = (await step("Query wms_handover for the shipment", `SELECT handover_id, parcel_no, order_no, event_code, scanned_at_utc FROM ${SOURCES_DB}.wms_handover WHERE parcel_no = '${SHIPMENT}' ORDER BY scanned_at_utc`))!;
const carrier = (await step("Query carrier_tracking for the shipment", `SELECT event_id, tracking_no, status, event_time, amends_event_id FROM ${SOURCES_DB}.carrier_tracking WHERE tracking_no = '${SHIPMENT}' ORDER BY event_time`))!;

// 4. The Unified Semantic Layer.
console.log("Building the Unified Semantic Layer");
await step("Create USL namespace", "CREATE NAMESPACE IF NOT EXISTS lightning.metastore.evidence_desk");
await step("Compile and deploy USL delivery_usl", `COMPILE USL IF NOT EXISTS delivery_usl DEPLOY NAMESPACE lightning.metastore.evidence_desk DDL ${sqlFile("delivery_usl.ddl.sql")}`);
await step("Activate delivery_evidence over both sources", `ACTIVATE USL TABLE ${USL}.delivery_evidence AS ${sqlFile("delivery_evidence.activate.sql")}`);
await step("List the USL's tables", `SHOW NAMESPACES OR TABLES IN ${USL}`);

// 5. Query the USL.
console.log("Querying the USL");
const unified = (await step("Query the USL for the disputed shipment", `SELECT evidence_id, source_system, source_record_ref, shipment_id, order_id, event_type, observed_at, supersedes_ref, inferred_fields FROM ${USL}.delivery_evidence WHERE shipment_id = '${SHIPMENT}' ORDER BY observed_at`))!;

// Check it against the source queries and against the scenario's records.
const col = (result: Result, name: string) => result.headers.indexOf(name);
const fromSources = [
  ...wms.data.map((row) => `wms:${row[col(wms, "handover_id")]}`),
  ...carrier.data.map((row) => `carrier:${row[col(carrier, "event_id")]}`)
].sort();
const fromUsl = unified.data.map((row) => row[col(unified, "evidence_id")]!).sort();
const scenario = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "fixtures", "scenarios", "disputed-delivery", "evidence.json"), "utf8")) as { records: Array<{ id: string; source: { system: string }; provenance: { recordRef: string } }> };
const expected = scenario.records.filter((record) => ["wms", "carrier"].includes(record.source.system));
const uslRefs = new Set(unified.data.map((row) => row[col(unified, "source_record_ref")]));
const checks = {
  uslMatchesSources: JSON.stringify(fromUsl) === JSON.stringify(fromSources),
  scenarioRecordsFound: expected.filter((record) => uslRefs.has(record.provenance.recordRef)).map((record) => record.id),
  scenarioRecordsExpected: expected.map((record) => record.id),
  correctionPreserved: unified.data.some((row) => row[col(unified, "supersedes_ref")] === "carrier:tracking/PCL-88412/events/7")
};
console.log(`  USL rows equal the two source queries: ${checks.uslMatchesSources}; scenario records found ${checks.scenarioRecordsFound.length}/${checks.scenarioRecordsExpected.length}; correction link preserved: ${checks.correctionPreserved}`);

// 6. Data quality on the real records.
console.log("Data quality");
await step("Register DQ rule on the USL", `REGISTER DQ ${RULE} TABLE ${USL}.delivery_evidence AS ${RULE_EXPRESSION}`, { tolerate: true });
await step("List DQ rules on the USL", `LIST DQ USL ${USL}`);
const dq = (await step("Run DQ rule on the USL", `RUN DQ ${RULE} TABLE ${USL}.delivery_evidence`))!;
await step("Show records failing the rule (USL)", `SHOW DQ INVALID RECORD ${RULE} TABLE ${USL}.delivery_evidence`);

// The failure case, isolated: a separate database, namespace and USL that
// add one labelled sample row with an empty carrier event id.
console.log("Data quality failure case (isolated sample)");
await step("Create Lightning database for the DQ sample", `CREATE LIGHTNING DATABASE ${SAMPLE_DB} DESCRIBE BY "SAMPLE DATA - isolated rows for the data-quality demonstration" OPTIONS ()`, { tolerate: true });
await step("Onboard the DQ sample row (JSON)", `CREATE LIGHTNING FILESTORE TABLE carrier_tracking_dq_sample FROM ${SAMPLE_DB} FORMAT json OPTIONS (path "file://${REMOTE}/carrier_tracking_dq_sample")`, { tolerate: true });
await step("Create sample USL namespace", "CREATE NAMESPACE IF NOT EXISTS lightning.metastore.evidence_desk_dq_sample");
await step("Compile sample USL", `COMPILE USL IF NOT EXISTS delivery_usl_dq_sample DEPLOY NAMESPACE lightning.metastore.evidence_desk_dq_sample DDL ${sqlFile("delivery_usl.ddl.sql")}`);
await step("Activate sample delivery_evidence (sources plus the sample row)", `ACTIVATE USL TABLE ${SAMPLE_USL}.delivery_evidence AS ${sqlFile("delivery_evidence.dq-sample.activate.sql")}`);
await step("Register DQ rule on the sample USL", `REGISTER DQ ${RULE} TABLE ${SAMPLE_USL}.delivery_evidence AS ${RULE_EXPRESSION}`, { tolerate: true });
const dqSample = (await step("Run DQ rule on the sample USL", `RUN DQ ${RULE} TABLE ${SAMPLE_USL}.delivery_evidence`))!;
const failing = (await step("Show records failing the rule (sample USL)", `SHOW DQ INVALID RECORD ${RULE} TABLE ${SAMPLE_USL}.delivery_evidence`))!;

// 7. Evidence Desk integration check: the same USL query through Evidence
// Desk's own Zetaris adapter (the SELECT route its live mode uses). The live
// evidence path itself is unchanged.
console.log("Evidence Desk integration check");
const adapter = new ZetarisEvidenceProvider(config.zetaris);
const began = performance.now();
const viaAdapter = await adapter.select(`SELECT evidence_id, source_record_ref FROM ${USL}.delivery_evidence WHERE shipment_id = '${SHIPMENT}' ORDER BY observed_at`, `${USL}.delivery_evidence`);
const integration = {
  rows: viaAdapter.records.length,
  queryToken: viaAdapter.queryToken,
  latencyMs: Math.round(performance.now() - began),
  sameAsUslQuery: JSON.stringify(viaAdapter.records.map((row) => String(row.evidence_id)).sort()) === JSON.stringify(fromUsl)
};
console.log(`  adapter read ${integration.rows} row(s) from the USL, query token ${integration.queryToken ? "present" : "absent"}, same rows: ${integration.sameAsUslQuery}`);

// Before/after on one repeatable task: retrieving the shipment's evidence in
// one consistent shape. Query latencies are measured here; the mapping work a
// consumer avoids is described in the reflection, not timed.
const timing = {
  sourceQueriesMs: (steps.find((item) => item.title === "Query wms_handover for the shipment")?.ms ?? 0) + (steps.find((item) => item.title === "Query carrier_tracking for the shipment")?.ms ?? 0),
  uslQueryMs: steps.find((item) => item.title === "Query the USL for the disputed shipment")?.ms ?? 0
};

const dqRow = (result: Result) => Object.fromEntries(result.headers.map((header, index) => [header, result.data[0]?.[index]]));
const report = {
  generatedAt: new Date().toISOString(),
  platform: config.zetaris.baseUrl,
  sources: {
    wms_handover: { table: `${SOURCES_DB}.wms_handover`, format: "csv", records: Number(wmsCount?.data[0]?.[0]) },
    carrier_tracking: { table: `${SOURCES_DB}.carrier_tracking`, format: "json", records: Number(carrierCount?.data[0]?.[0]) }
  },
  usl: { table: `${USL}.delivery_evidence`, headers: unified.headers, rows: unified.data },
  checks,
  dataQuality: { rule: RULE, expression: RULE_EXPRESSION, usl: dqRow(dq), isolatedSample: dqRow(dqSample), failingSampleRecords: failing.data },
  integration,
  timing,
  steps
};
const out = path.join(ROOT_DIR, "eval", "results");
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "zetaris-usl.json"), `${JSON.stringify(report, null, 2)}\n`);
fs.writeFileSync(path.join(out, "zetaris-usl.md"), renderSteps(steps));
console.log(`\nDQ on the USL: ${report.dataQuality.usl.total_record} checked, ${report.dataQuality.usl.valid_record} passed, ${report.dataQuality.usl.invalid_record} failed`);
console.log(`DQ on the isolated sample: ${report.dataQuality.isolatedSample.total_record} checked, ${report.dataQuality.isolatedSample.valid_record} passed, ${report.dataQuality.isolatedSample.invalid_record} failed`);
console.log(`Timing (one run): two source queries ${timing.sourceQueriesMs} ms; one USL query ${timing.uslQueryMs} ms`);
console.log(`Report: eval/results/zetaris-usl.md and .json`);
const ok = checks.uslMatchesSources && checks.scenarioRecordsFound.length === checks.scenarioRecordsExpected.length && checks.correctionPreserved && integration.sameAsUslQuery;
process.exit(ok ? 0 : 1);

function renderSteps(items: Step[]): string {
  const lines = ["# Zetaris USL run", "", `Generated ${report.generatedAt} against ${config.zetaris.baseUrl}.`, ""];
  for (const item of items) {
    lines.push(`## ${item.title}`, "", `${item.outcome}${item.ms ? `, ${item.ms} ms` : ""}`, "", "```sql", item.sql, "```", "");
    if (item.error) lines.push("```", item.error, "```", "");
    if (item.headers?.length) {
      lines.push(`| ${item.headers.join(" | ")} |`, `|${item.headers.map(() => "---").join("|")}|`);
      for (const row of item.rows ?? []) lines.push(`| ${row.map((value) => value.replace(/\|/g, "\\|").replace(/\n/g, " ")).join(" | ")} |`);
      lines.push("");
    }
  }
  return `${lines.join("\n")}\n`;
}
