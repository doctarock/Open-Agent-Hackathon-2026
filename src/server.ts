import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, loadConfig, loadDotEnv, type AppConfig } from "./config.js";
import { EvidenceProviderError } from "./evidence/types.js";
import { EvidenceDesk, MARKOVIAN_SOURCE, ReasonerNotReadyError, RunInProgressError, relativeDataPath } from "./investigation/desk.js";

// A small HTTP server: JSON API under /api, the static UI from public/, and
// run progress (Meterless progress events) as server-sent events.

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8"
};

export function createServer(desk: EvidenceDesk, config: AppConfig): http.Server {
  const publicDir = path.join(config.rootDir, "public");
  const listeners = new Set<http.ServerResponse>();
  const broadcast = (event: string, data: unknown) => {
    for (const response of listeners) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  desk.on("progress", (state) => broadcast("progress", {
    runId: state.runId, phase: state.phase, phaseDetail: state.phaseDetail,
    currentChunk: state.currentChunk, maxChunks: state.maxChunks, logs: state.logs
  }));
  desk.on("run", (summary) => broadcast("run", summary));

  const routes: Record<string, (request: http.IncomingMessage, response: http.ServerResponse) => Promise<void>> = {
    "GET /api/status": async (_request, response) => json(response, 200, status(desk, config)),
    "GET /api/evidence": async (_request, response) => json(response, 200, await desk.listEvidence()),
    "GET /api/investigation": async (_request, response) => {
      const runs = desk.runs();
      json(response, 200, {
        // What Speck believes now, read from its persisted state. The page
        // shows this, not the copy stored with the last run.
        current: runs.length ? desk.conclusionFromSpeck() : null,
        latestRun: runs.at(-1) ?? null,
        runs: runs.map((run) => ({
          runNumber: run.runNumber, runId: run.runId, finishedAt: run.finishedAt, stage: run.stage,
          status: run.execution.status, conclusion: run.conclusion.state, hypothesis: run.conclusion.hypothesis?.key ?? null,
          evidenceMode: run.evidence.mode, reasoner: run.reasoner.kind, model: run.reasoner.model
        })),
        hypotheses: desk.hypotheses(),
        timeline: desk.timeline()
      });
    },
    "POST /api/run": async (_request, response) => json(response, 200, await desk.run()),
    "POST /api/update": async (_request, response) => json(response, 200, { stage: await desk.introduceNextUpdate(), next: desk.nextStage() }),
    "GET /api/events": async (request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      response.write(": connected\n\n");
      listeners.add(response);
      request.on("close", () => listeners.delete(response));
    }
  };

  return http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const route = routes[`${request.method} ${url.pathname}`];
    try {
      if (route) return await route(request, response);
      if (request.method === "GET" && !url.pathname.startsWith("/api/")) return serveStatic(publicDir, url.pathname, response);
      json(response, 404, { error: `No route for ${request.method} ${url.pathname}` });
    } catch (error) {
      sendError(response, error);
    }
  });
}

function status(desk: EvidenceDesk, config: AppConfig) {
  return {
    case: { caseId: desk.scenario.caseId, title: desk.scenario.title, question: desk.scenario.question, scenarioId: desk.scenario.id },
    stage: desk.currentStage(),
    nextStage: desk.nextStage(),
    running: desk.isRunning,
    evidence: desk.provider.describe(),
    reasoner: { ...desk.reasoner.describe(), usage: desk.reasoner.usage() },
    execution: { engine: MARKOVIAN_SOURCE, maxChunks: config.execution.maxChunks, batchSize: config.execution.batchSize },
    speck: { database: relativeDataPath(config, config.databasePath) }
  };
}

function sendError(response: http.ServerResponse, error: unknown): void {
  if (response.headersSent) { response.end(); return; }
  if (error instanceof EvidenceProviderError) {
    return json(response, 502, { error: error.message, hint: error.hint, detail: error.detail, kind: "evidence", mode: error.mode });
  }
  if (error instanceof RunInProgressError) return json(response, 409, { error: error.message, kind: "busy" });
  if (error instanceof ReasonerNotReadyError) return json(response, 503, { error: error.message, hint: error.hint, kind: "reasoner" });
  json(response, 500, { error: error instanceof Error ? error.message : String(error), kind: "internal" });
}

function json(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function serveStatic(publicDir: string, pathname: string, response: http.ServerResponse): void {
  const file = path.resolve(publicDir, `.${pathname === "/" ? "/index.html" : pathname}`);
  if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return json(response, 404, { error: "Not found" });
  }
  response.writeHead(200, { "content-type": STATIC_TYPES[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(response);
}

async function main(): Promise<void> {
  loadDotEnv();
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) { console.error(`Configuration error: ${error.message}`); process.exit(1); }
    throw error;
  }
  const desk = await EvidenceDesk.open(config);
  const server = createServer(desk, config);
  server.listen(config.port, config.host, () => {
    const evidence = desk.provider.describe();
    const reasoner = desk.reasoner.describe();
    console.log(`Evidence Desk on http://${config.host}:${config.port}`);
    console.log(`  evidence: ${evidence.label} -> ${evidence.target}${evidence.problem ? ` [${evidence.problem}]` : ""}`);
    console.log(`  reasoner: ${reasoner.label}${reasoner.model ? ` (${reasoner.model} @ ${reasoner.endpoint})` : ""}${reasoner.problem ? ` [${reasoner.problem}]` : ""}`);
    console.log(`  speck db: ${relativeDataPath(config, config.databasePath)}`);
  });
  const shutdown = () => { server.close(); desk.close(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
