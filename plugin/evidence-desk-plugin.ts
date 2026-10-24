import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import type { SpeckRuntime } from "#speck";
import { loadConfig, repositoryRoot, ROOT_DIR, type CaseConfig } from "../src/config.js";
import { DESK_ROUTES, deskApi, errorResponse, NotFoundError, RequestError, type DeskApi } from "../src/investigation/api.js";
import { EvidenceDesk, retireCase, RunInProgressError } from "../src/investigation/desk.js";
import { FixtureEvidenceProvider } from "../src/evidence/fixture-provider.js";
import { addUserEvidence, createUserCase, listUserCases } from "../src/investigation/user-cases.js";
import { loadScenario } from "../src/scenario.js";
import { evaluationSummary } from "../src/compare/evaluation.js";
import { METERLESS_TOKEN_KEY } from "../src/reasoning/meterless.js";

// Evidence Desk as a Speck plugin. Speck loads this file (as
// speck/plugins/evidence-desk/dist/plugin/evidence-desk-plugin.js, put there
// by `npm run plugin:install`) and hands it its own runtime. Each case is a
// worker in Speck's database, beside Speck's other workers, and the page is
// a tab in Speck's interface (its home view when started with npm run speck).
//
// Settings come from the .env of the repository the plugin was installed from
// (install.json), the same file the standalone server and npm run configure
// use, read on each case's first use without touching Speck's environment; a
// variable already set in Speck's environment wins.

export const PLUGIN_ID = "evidence-desk";
const API_BASE = `/api/plugins/${PLUGIN_ID}`;
const ASSET_BASE = `/plugins/${PLUGIN_ID}`;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const ASSETS: Record<string, { file: string; type: string }> = {
  "ui.js": { file: path.join(ROOT_DIR, "plugin", "ui", "evidence-desk-ui.js"), type: "text/javascript" },
  "app.js": { file: path.join(PUBLIC_DIR, "app.js"), type: "text/javascript" },
  "tour.js": { file: path.join(PUBLIC_DIR, "tour.js"), type: "text/javascript" },
  "status.js": { file: path.join(PUBLIC_DIR, "status.js"), type: "text/javascript" },
  "journey.js": { file: path.join(PUBLIC_DIR, "journey.js"), type: "text/javascript" },
  "compare.js": { file: path.join(PUBLIC_DIR, "compare.js"), type: "text/javascript" },
  "decisive.js": { file: path.join(PUBLIC_DIR, "decisive.js"), type: "text/javascript" },
  "style.css": { file: path.join(PUBLIC_DIR, "style.css"), type: "text/css" }
};

// The cases the tab offers. The disputed delivery follows the plugin's
// settings (live Zetaris and Nemotron, or fixtures); the bank return is the
// held-out correction case and always runs on its fixture with the rules.
export interface CaseSpec {
  id: string;
  label: string;
  scenarioDir: string;
  fixed?: { evidenceMode: "fixture"; reasoner?: "rules" };
  // An investigation a person created from the tab (src/investigation/user-cases.ts).
  yours?: boolean;
}
export const CASES: CaseSpec[] = [
  { id: "disputed-delivery", label: "Disputed delivery", scenarioDir: "fixtures/scenarios/disputed-delivery" },
  { id: "bank-return", label: "Bank return", scenarioDir: "eval/scenarios/correction-supersedes", fixed: { evidenceMode: "fixture", reasoner: "rules" } }
];

export function pluginSettings(rootDir = ROOT_DIR): NodeJS.ProcessEnv {
  const file = path.join(repositoryRoot(rootDir), ".env");
  const fromFile = fs.existsSync(file) ? parseEnv(fs.readFileSync(file, "utf8")) : {};
  return { ...fromFile, ...process.env };
}

// dataRoot: where the case's own data folder goes (a person's investigations
// keep it beside their cases folder, which by default is the same data/).
export function caseConfig(spec: CaseSpec, settings: NodeJS.ProcessEnv, rootDir = ROOT_DIR, dataRoot = path.join(rootDir, "data")): CaseConfig {
  const env = { ...settings, EVIDENCE_DESK_SCENARIO: spec.scenarioDir,
    ...(spec.fixed ? { EVIDENCE_MODE: spec.fixed.evidenceMode, ...(spec.fixed.reasoner ? { REASONER: spec.fixed.reasoner } : {}) } : {}) };
  const dataDir = path.join(dataRoot, spec.id);
  // The case lives in Speck's own database, and Speck serves it: the
  // standalone database and server settings do not apply.
  const { databasePath: _database, host: _host, port: _port, ...config } = loadConfig(env, { rootDir, historyDir: path.join(dataDir, "meterless") });
  return config;
}

// Where the investigations a person creates are kept.
export const userCasesDir = (rootDir = ROOT_DIR) => path.join(rootDir, "data", "user-cases");

// The cases, attached to Speck's runtime on first use: the prepared ones,
// then the investigations created from the tab.
// userCasesDir: where a person's investigations are kept (tests use a temporary one).
// secret: Speck's secret store (speck:secret-get), where Speck keeps the
// Meterless Runtime token; when it holds one, it wins over .env, so a token
// saved in Speck's System view reaches the cases too.
export function createCaseRegistry(runtime: () => SpeckRuntime, options: { rootDir?: string; settings?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; userCasesDir?: string; secret?: (handle: string) => Promise<string | null> } = {}) {
  const rootDir = options.rootDir ?? ROOT_DIR;
  const ownDir = options.userCasesDir ?? userCasesDir(rootDir);
  const opened = new Map<string, Promise<{ desk: EvidenceDesk; api: DeskApi }>>();
  // A person's evidence is a local file they wrote, never Zetaris; the
  // assessor follows the settings (only a model can weigh free text).
  const specs = (): CaseSpec[] => [...CASES, ...listUserCases(ownDir).map((item) => ({ ...item, fixed: { evidenceMode: "fixture" as const }, yours: true }))];
  const find = (id: string) => {
    const spec = specs().find((candidate) => candidate.id === id);
    if (!spec) throw new NotFoundError(`Unknown case "${id}"`);
    return spec;
  };
  return {
    list: () => specs().map((spec) => ({ id: spec.id, label: spec.label, kind: spec.yours ? "yours" : "prepared" })),
    // The evaluation reports and saved comparisons, read from the repository.
    evaluation: () => evaluationSummary(rootDir),
    create(input: unknown) {
      const created = createUserCase(ownDir, input);
      return { id: created.id, label: created.label, kind: "yours" };
    },
    addEvidence(id: string, input: unknown) {
      const spec = find(id);
      if (!spec.yours) throw new RequestError("Evidence can only be added to an investigation you created; the prepared cases' evidence is fixed");
      return addUserEvidence(spec.scenarioDir, input);
    },
    // Deletes an investigation the person created. Its Speck workers are
    // suspended and its summary archived (retireCase); its folder and engine
    // history move to data/deleted-cases/<time>-<id>/, from which it can be
    // restored. The prepared cases cannot be deleted, only reset.
    async remove(id: string) {
      const spec = find(id);
      // The prepared demo cases are refused by name as well, whatever else is true.
      if (!spec.yours || CASES.some((prepared) => prepared.id === id)) throw new RequestError("Only an investigation you created can be deleted; the prepared cases can be reset instead");
      const entry = opened.get(id);
      const desk = entry ? (await entry.catch(() => null))?.desk ?? null : null;
      if (desk?.isRunning) throw new RunInProgressError("A run of this investigation is in progress; wait for it to finish");
      const scenario = loadScenario(spec.scenarioDir);
      const { suspended } = await retireCase(runtime(), scenario, `Investigation ${scenario.caseId} deleted from the Evidence tab`);
      opened.delete(id);
      desk?.close();
      const kept = path.join(path.dirname(ownDir), "deleted-cases", `${new Date().toISOString().replace(/[:.]/g, "-")}-${id}`);
      fs.mkdirSync(kept, { recursive: true });
      fs.renameSync(spec.scenarioDir, path.join(kept, "case"));
      const history = path.join(path.dirname(ownDir), id);
      if (fs.existsSync(history)) fs.renameSync(history, path.join(kept, "data"));
      return { deleted: id, label: spec.label, suspendedWorkers: suspended.length, keptIn: path.relative(rootDir, kept) };
    },
    async get(id: string): Promise<{ desk: EvidenceDesk; api: DeskApi }> {
      const spec = find(id);
      let entry = opened.get(id);
      if (!entry) {
        entry = (async () => {
          const settings = options.settings ?? pluginSettings(rootDir);
          const token = await options.secret?.(METERLESS_TOKEN_KEY).catch(() => null);
          const config = caseConfig(spec, token ? { ...settings, [METERLESS_TOKEN_KEY]: token } : settings, rootDir, spec.yours ? path.dirname(ownDir) : undefined);
          const provider = spec.yours ? new FixtureEvidenceProvider(path.join(spec.scenarioDir, "evidence.json"), config.rootDir, "Evidence you entered (stored locally, not Zetaris)") : null;
          const desk = await EvidenceDesk.attach(runtime(), config, { ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}), ...(provider ? { provider } : {}) });
          return { desk, api: deskApi(desk, config, "Speck's own database (this case is a Speck worker)") };
        })();
        opened.set(id, entry);
        entry.catch(() => opened.delete(id));
      }
      return entry;
    }
  };
}

type Handler = (req: { params: Record<string, string>; body?: unknown }, res: {
  status(code: number): { json(body: unknown): void; type(value: string): { send(body: unknown): void } };
  json(body: unknown): void;
  set(field: string, value: string): unknown;
  type(value: string): { send(body: unknown): void };
}) => unknown;
interface RouteApp { get(path: string, handler: Handler): unknown; post(path: string, handler: Handler): unknown }
interface PluginApi {
  getRuntimeContext(): { speck?: SpeckRuntime };
  getCapability?(name: string): ((input: unknown) => unknown) | undefined;
  registerUiPrimaryTab?(tab: { id: string; title: string; order: number; scriptUrl: string }): unknown;
}

// Registers the tab's assets and the per-case JSON API under Speck's plugin
// routes (Speck requires its admin session for everything under /api/plugins).
export function registerEvidenceDeskRoutes(app: RouteApp, cases: ReturnType<typeof createCaseRegistry>): void {
  for (const [name, asset] of Object.entries(ASSETS)) {
    app.get(`${ASSET_BASE}/${name}`, async (_req, res) => {
      try {
        res.set("cache-control", "no-cache");
        res.type(asset.type).send(await fs.promises.readFile(asset.file, "utf8"));
      } catch {
        res.status(404).type("text/plain").send("Evidence Desk asset is unavailable");
      }
    });
  }
  app.get(`${API_BASE}/cases`, (_req, res) => res.json({ cases: cases.list() }));
  app.get(`${API_BASE}/evaluation`, (_req, res) => res.json(cases.evaluation()));
  const plain = (operation: (req: { params: Record<string, string>; body?: unknown }) => unknown): Handler => async (req, res) => {
    try {
      res.json(await operation(req));
    } catch (error) {
      const { status, body } = errorResponse(error);
      res.status(status).json(body);
    }
  };
  // A new investigation of the person's own, and evidence added to one.
  app.post(`${API_BASE}/cases`, plain((req) => cases.create(req.body)));
  app.post(`${API_BASE}/cases/:caseId/evidence/add`, plain((req) => cases.addEvidence(String(req.params.caseId ?? ""), req.body)));
  app.post(`${API_BASE}/cases/:caseId/delete`, plain((req) => cases.remove(String(req.params.caseId ?? ""))));
  // Each case's API (DESK_ROUTES): the operations the standalone server serves under /api.
  for (const route of DESK_ROUTES) {
    const handler = plain(async (req) => route.handle((await cases.get(String(req.params.caseId ?? ""))).api, { body: req.body, params: req.params }));
    if (route.method === "GET") app.get(`${API_BASE}/cases/:caseId${route.path}`, handler);
    else app.post(`${API_BASE}/cases/:caseId${route.path}`, handler);
  }
}

export default function createEvidenceDeskPlugin() {
  let cases: ReturnType<typeof createCaseRegistry> | null = null;
  const casesFor = (api: PluginApi) => {
    cases ||= createCaseRegistry(() => {
      const runtime = api.getRuntimeContext().speck;
      if (!runtime) throw new Error("Speck did not provide its runtime to the Evidence Desk plugin");
      return runtime;
    }, { secret: async (handle) => {
      const get = api.getCapability?.("speck:secret-get");
      return typeof get === "function" ? (await get({ handle }) as string | null) : null;
    } });
    return cases;
  };
  return {
    id: PLUGIN_ID,
    name: "Evidence Desk",
    version: "0.1.0",
    description: "Investigates cases whose evidence conflicts and changes over time, with Speck holding the beliefs and their revision history.",
    manifest: {
      schemaVersion: 1,
      permissions: { routes: true, uiPanels: true, data: false, tools: [], capabilities: [], hooks: [], runtimeContext: ["speck"] },
      dependencies: { requiredCapabilities: [], optionalCapabilities: ["speck:secret-get"] },
      security: { isolation: "inprocess" }
    },
    init(api: PluginApi) {
      api.registerUiPrimaryTab?.({ id: "evidence", title: "Evidence", order: 45, scriptUrl: `${ASSET_BASE}/ui.js` });
    },
    registerRoutes({ app, api }: { app: RouteApp; api: PluginApi }) {
      registerEvidenceDeskRoutes(app, casesFor(api));
    }
  };
}
