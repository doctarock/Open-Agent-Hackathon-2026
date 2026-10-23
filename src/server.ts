import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, loadConfig, loadDotEnv, type AppConfig } from "./config.js";
import { deskApi, errorResponse, RequestError } from "./investigation/api.js";
import { EvidenceDesk, relativeDataPath } from "./investigation/desk.js";

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
  desk.on("revision", (summary) => broadcast("revision", summary));

  const api = deskApi(desk, config, relativeDataPath(config, config.databasePath));
  const routes: Record<string, (request: http.IncomingMessage, response: http.ServerResponse) => Promise<void>> = {
    "GET /api/status": async (_request, response) => json(response, 200, api.status()),
    "GET /api/evidence": async (_request, response) => json(response, 200, await api.evidence()),
    "GET /api/trace": async (_request, response) => json(response, 200, api.trace()),
    "GET /api/investigation": async (_request, response) => json(response, 200, api.investigation()),
    "POST /api/run": async (_request, response) => json(response, 200, await api.run()),
    "POST /api/evidence/withdraw": async (request, response) => json(response, 200, await api.withdraw(await readJson(request))),
    "POST /api/update": async (_request, response) => json(response, 200, await api.update()),
    "POST /api/reset": async (_request, response) => json(response, 200, await api.reset()),
    "GET /api/progress": async (_request, response) => json(response, 200, api.progress()),
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

function sendError(response: http.ServerResponse, error: unknown): void {
  if (response.headersSent) { response.end(); return; }
  const { status, body } = errorResponse(error);
  json(response, status, body);
}

async function readJson(request: http.IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 16_384) throw new RequestError("Request body too large");
  }
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw new RequestError("Request body is not valid JSON");
  }
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
  // no-cache (revalidate), as the plugin serves them: a browser must not keep
  // running an older page after Evidence Desk is updated.
  response.writeHead(200, { "content-type": STATIC_TYPES[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
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
