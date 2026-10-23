import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { SpeckRuntime } from "#speck";
import createEvidenceDeskPlugin, { caseConfig, CASES, createCaseRegistry, registerEvidenceDeskRoutes } from "../plugin/evidence-desk-plugin.js";
import { ROOT_DIR } from "../src/config.js";
import { installPlugin } from "../src/scripts/plugin-install.js";
import { EVIDENCE_HOME_VIEW } from "../src/scripts/speck.js";
import { tempDir } from "./helpers.js";

// Evidence Desk as a Speck plugin, tested against a real Speck runtime and
// Speck's own Express (as Speck's host builds it: JSON bodies parsed). The
// plugin API Speck hands over is reduced to what the plugin uses.

const express = createRequire(path.join(ROOT_DIR, "speck", "package.json"))("express") as (() => any) & { json(): unknown };

async function withSpeck<T>(body: (context: { runtime: SpeckRuntime; base: string; tabs: unknown[] }) => Promise<T>): Promise<T> {
  const runtime = new SpeckRuntime({ databasePath: path.join(tempDir(), "speck.sqlite") });
  await runtime.initialize();
  const app = express();
  app.use(express.json());
  const tabs: unknown[] = [];
  const api = { getRuntimeContext: () => ({ speck: runtime }), registerUiPrimaryTab: (tab: unknown) => tabs.push(tab) };
  const plugin = createEvidenceDeskPlugin();
  plugin.init(api);
  plugin.registerRoutes({ app, api });
  const server = http.createServer(app).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    return await body({ runtime, base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, tabs });
  } finally {
    server.close();
    runtime.close();
  }
}

const call = async (base: string, route: string, method = "GET", body?: unknown) => {
  const response = await fetch(`${base}${route}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json().catch(() => null) as any };
};

test("the plugin declares a Speck tab and runs a case on Speck's own runtime, beside Speck's other work", async () => {
  await withSpeck(async ({ runtime, base, tabs }) => {
    assert.deepEqual(tabs, [{ id: "evidence", title: "Evidence", order: 45, scriptUrl: "/plugins/evidence-desk/ui.js" }]);
    // npm run speck opens Speck on this tab (Speck names a plugin tab's view plugin:<pluginId>:<tabId>).
    assert.equal(EVIDENCE_HOME_VIEW, `plugin:${createEvidenceDeskPlugin().id}:evidence`);
    const manifest = createEvidenceDeskPlugin().manifest;
    assert.deepEqual(manifest.permissions.runtimeContext, ["speck"]);
    assert.equal(manifest.permissions.routes, true);
    assert.equal(manifest.permissions.uiPanels, true);

    // An unrelated Speck worker, which the plugin must leave alone.
    const other = await runtime.createWorker("Someone else's task", [], { kind: "user", source: "test" });
    const otherObjects = runtime.mentalObjects.listForWorker(other.id).length;

    assert.deepEqual((await call(base, "/api/plugins/evidence-desk/cases")).body.cases.filter((item: any) => item.kind === "prepared"),
      CASES.map((spec) => ({ id: spec.id, label: spec.label, kind: "prepared" })));
    const bank = "/api/plugins/evidence-desk/cases/bank-return";
    const status = (await call(base, `${bank}/status`)).body;
    assert.equal(status.evidence.mode, "fixture");
    assert.equal(status.reasoner.kind, "rules");
    assert.equal(status.speck.database, "Speck's own database (this case is a Speck worker)");
    assert.equal((await call(base, `${bank}/run`, "POST")).status, 200);
    assert.equal((await call(base, `${bank}/update`, "POST")).status, 200);
    assert.equal((await call(base, `${bank}/run`, "POST")).status, 200);
    const investigation = (await call(base, `${bank}/investigation`)).body;
    assert.equal(investigation.current.state, "supported");
    assert.equal(investigation.current.hypothesis.key, "H-UNPAID");
    assert.equal(investigation.current.hypothesis.confidence, 0.66);
    const trace = (await call(base, `${bank}/trace`)).body;
    assert.equal(trace.entries.filter((entry: any) => entry.kind === "run").length, 2);

    // The case is one of Speck's workers, waiting on evidence, not a queued task.
    const workers = runtime.listWorkers();
    const caseWorker = workers.find((worker) => worker.objective.constraints.includes("evidence-desk:case=EVAL-PAY-01"))!;
    assert.equal(caseWorker.status, "waiting");
    assert.equal(runtime.getWorker(other.id)!.status, "created");
    assert.equal(runtime.mentalObjects.listForWorker(other.id).length, otherObjects, "the other worker was not touched");

    // Reset inside Speck: a fresh copy of the case; nothing else in Speck changes.
    assert.equal((await call(base, `${bank}/progress`)).body.running, false);
    const reset = await call(base, `${bank}/reset`, "POST");
    assert.deepEqual([reset.status, reset.body.restarted, reset.body.generation, reset.body.runs], [200, true, 2, 0]);
    assert.equal(runtime.getWorker(caseWorker.id)!.status, "suspended");
    assert.equal(runtime.getWorker(other.id)!.status, "created");
    assert.equal(runtime.mentalObjects.listForWorker(other.id).length, otherObjects, "the other worker was not touched by the reset");
    assert.equal((await call(base, `${bank}/investigation`)).body.current, null, "the fresh copy has no conclusion yet");
    assert.equal((await call(base, `${bank}/reset`, "POST")).body.restarted, false, "a second reset does nothing");

    // Errors come back as the page expects them.
    assert.equal((await call(base, `${bank}/evidence/withdraw`, "POST", { recordId: "EV-BNK-101" })).status, 400);
    assert.equal((await call(base, "/api/plugins/evidence-desk/cases/nope/status")).status, 404);
    // The tab's assets are served.
    for (const asset of ["ui.js", "app.js", "tour.js", "status.js", "style.css"]) {
      const response = await fetch(`${base}/plugins/evidence-desk/${asset}`);
      assert.equal(response.status, 200, asset);
    }
  });
});

test("cases opened through the plugin survive a Speck restart on the same database", async () => {
  const database = path.join(tempDir(), "speck.sqlite");
  const open = async () => {
    const runtime = new SpeckRuntime({ databasePath: database });
    await runtime.initialize();
    return runtime;
  };
  const runtime = await open();
  const cases = createCaseRegistry(() => runtime, { rootDir: ROOT_DIR, settings: {} });
  const { desk } = await cases.get("bank-return");
  await desk.run();
  await desk.introduceNextUpdate();
  await desk.run();
  const before = desk.conclusionFromSpeck();
  runtime.close();
  const reopened = await open();
  try {
    const again = await createCaseRegistry(() => reopened, { rootDir: ROOT_DIR, settings: {} }).get("bank-return");
    assert.deepEqual(again.desk.conclusionFromSpeck(), before);
    assert.equal(again.desk.runs().length, 2);
    assert.equal(reopened.listWorkers().length, 1, "the same case worker, not a second one");
  } finally {
    reopened.close();
  }
});

test("the bank-return case always runs on its fixture with the rules, whatever the plugin's settings", () => {
  const settings = { EVIDENCE_MODE: "zetaris", REASONER: "nemotron", NEMOTRON_MODEL: "nemotron-x", NEMOTRON_BASE_URL: "http://127.0.0.1:9/v1" };
  const bank = caseConfig(CASES.find((spec) => spec.id === "bank-return")!, settings);
  assert.deepEqual([bank.evidenceMode, bank.reasoner], ["fixture", "rules"]);
  const delivery = caseConfig(CASES.find((spec) => spec.id === "disputed-delivery")!, settings);
  assert.deepEqual([delivery.evidenceMode, delivery.reasoner], ["zetaris", "nemotron"]);
  assert.notEqual(bank.historyDir, delivery.historyDir, "each case keeps its own Meterless history");
});

test("the installer copies the plugin into Speck's plugins folder and approves exactly its entry module", () => {
  // A stand-in Speck checkout: its dist/index.js and its trust file.
  const speckDir = tempDir();
  fs.mkdirSync(path.join(speckDir, "dist"));
  fs.writeFileSync(path.join(speckDir, "dist", "index.js"), "export {};\n");
  fs.mkdirSync(path.join(speckDir, "plugins", ".runtime"), { recursive: true });
  const existing = { allowlist: { "social-media-manager": { hashes: ["abc"] } }, mode: "allowlist" };
  fs.writeFileSync(path.join(speckDir, "plugins", ".runtime", "plugin-trust.json"), JSON.stringify(existing));
  const settingsFile = path.join(tempDir(), ".env");
  fs.writeFileSync(settingsFile, "EVIDENCE_MODE=fixture\n");

  const first = installPlugin({ speckDir, settingsFile });
  const target = path.join(speckDir, "plugins", "evidence-desk");
  assert.equal(first.target, target);
  for (const file of ["dist/plugin/evidence-desk-plugin.js", "dist/src/investigation/desk.js", "plugin/ui/evidence-desk-ui.js", "public/app.js", "public/style.css",
    "fixtures/scenarios/disputed-delivery/scenario.json", "eval/scenarios/correction-supersedes/scenario.json", "config/zetaris-queries.json", "public/tour.js", "public/status.js"]) {
    assert.ok(fs.existsSync(path.join(target, file)), file);
  }
  // "#speck" now points at the stand-in Speck's own dist/index.js.
  const desk = fs.readFileSync(path.join(target, "dist", "src", "investigation", "desk.js"), "utf8");
  assert.ok(!desk.includes('"#speck"'));
  assert.ok(desk.includes(`from "${pathToFileURL(path.join(speckDir, "dist", "index.js")).href}"`));
  // The only module Speck loads as a plugin is the entry.
  const plugins = walk(target).filter((file) => /-plugin\.(?:m?js|cjs)$/.test(file));
  assert.deepEqual(plugins.map((file) => path.relative(target, file).split(path.sep).join("/")), ["dist/plugin/evidence-desk-plugin.js"]);
  // Trust: the entry's hash is added; other plugins and the mode are kept.
  const trust = JSON.parse(fs.readFileSync(path.join(speckDir, "plugins", ".runtime", "plugin-trust.json"), "utf8"));
  assert.deepEqual(trust, { allowlist: { "social-media-manager": { hashes: ["abc"] }, "evidence-desk": { hashes: [first.entryHash] } }, mode: "allowlist" });
  assert.equal(fs.readFileSync(path.join(target, ".env"), "utf8"), "EVIDENCE_MODE=fixture\n");

  // A reinstall keeps the plugin's settings and the cases' data.
  fs.writeFileSync(path.join(target, ".env"), "EVIDENCE_MODE=zetaris\n");
  fs.mkdirSync(path.join(target, "data", "bank-return"), { recursive: true });
  fs.writeFileSync(path.join(target, "data", "bank-return", "kept.txt"), "x");
  const second = installPlugin({ speckDir, settingsFile });
  assert.match(second.settings, /kept/);
  assert.equal(fs.readFileSync(path.join(target, ".env"), "utf8"), "EVIDENCE_MODE=zetaris\n");
  assert.ok(fs.existsSync(path.join(target, "data", "bank-return", "kept.txt")));
});

function walk(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

test("a person creates an investigation through the plugin and adds evidence to it; the prepared cases' evidence is fixed", async () => {
  const runtime = new SpeckRuntime({ databasePath: path.join(tempDir(), "speck.sqlite") });
  await runtime.initialize();
  const app = express();
  app.use(express.json());
  const own = tempDir();
  registerEvidenceDeskRoutes(app, createCaseRegistry(() => runtime, { rootDir: ROOT_DIR, settings: {}, userCasesDir: own }));
  const server = http.createServer(app).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    assert.equal((await call(base, "/api/plugins/evidence-desk/cases", "POST", { title: "x", question: "y", explanations: ["only one"] })).status, 400);
    const created = await call(base, "/api/plugins/evidence-desk/cases", "POST", {
      title: "Missing laptop return", question: "Was laptop SN-4471 returned?",
      explanations: ["Returned and lost at the warehouse.", "Never sent back."],
      evidence: [{ source: "Courier", content: "Pickup from the customer on 3 Oct.", observedAt: "2026-10-03T09:00:00Z" }]
    });
    assert.deepEqual(created, { status: 200, body: { id: "my-1", label: "Missing laptop return", kind: "yours" } });
    const cases = (await call(base, "/api/plugins/evidence-desk/cases")).body.cases;
    assert.deepEqual(cases.map((item: any) => [item.id, item.kind]), [["disputed-delivery", "prepared"], ["bank-return", "prepared"], ["my-1", "yours"]]);
    const status = (await call(base, "/api/plugins/evidence-desk/cases/my-1/status")).body;
    assert.deepEqual([status.case.caseId, status.evidence.mode, status.evidence.label], ["MY-1", "fixture", "Evidence you entered (stored locally, not Zetaris)"]);
    assert.deepEqual((await call(base, "/api/plugins/evidence-desk/cases/my-1/evidence")).body.pending, ["E-1"]);
    const added = await call(base, "/api/plugins/evidence-desk/cases/my-1/evidence/add", "POST", { source: "Warehouse", content: "No inbound scan for SN-4471." });
    assert.deepEqual(added, { status: 200, body: { recordId: "E-2" } });
    assert.deepEqual((await call(base, "/api/plugins/evidence-desk/cases/my-1/evidence")).body.pending, ["E-1", "E-2"]);
    assert.equal((await call(base, "/api/plugins/evidence-desk/cases/bank-return/evidence/add", "POST", { source: "x", content: "y" })).status, 400);
    assert.ok(!fs.existsSync(path.join(ROOT_DIR, "data", "user-cases", "my-1")), "nothing was written to the repository's data folder");
  } finally {
    server.close();
    runtime.close();
  }
});
