import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { parseEnv } from "node:util";
import { ROOT_DIR } from "../config.js";

// npm run speck
//
// Starts Speck with Evidence Desk as its home view: the interface opens on the
// Evidence tab, which is first in the rail, and Speck's brand button and panel
// close return to it. Speck's other views stay available. Any SPECK_* setting
// in the environment is passed through; SPECK_HOME_VIEW=world restores Speck's
// own default.
//
// A Speck already listening on the same address is stopped first, so the new
// one can start. Anything else on that port is left alone, and nothing starts.
//
// Once the new Speck answers, its address opens in the default browser;
// SPECK_OPEN_BROWSER=0 leaves the browser alone.

export const EVIDENCE_HOME_VIEW = "plugin:evidence-desk:evidence";

// The address Speck will listen on, read as Speck's own configuration reads it.
export function speckAddress(env: NodeJS.ProcessEnv = process.env): { host: string; port: number } {
  const port = Number(env.SPECK_PORT ?? env.PORT ?? 4310);
  const host = env.SPECK_HOST ?? "127.0.0.1";
  return { host: host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host, port: Number.isInteger(port) && port > 0 ? port : 4310 };
}

// Speck's chat reads the Meterless token from its secret store, else from the
// meterless_runtime_token variable. npm run setup skips configure (which
// writes the store) when .env already exists, so a fresh clone with a kept
// .env would leave the chat unauthorized while the cases work. Only that one
// key is passed through; the rest of .env stays out of Speck's environment,
// and a token already set in the environment or the store still wins.
export function speckEnv(env: NodeJS.ProcessEnv, dotEnvText: string | null): NodeJS.ProcessEnv {
  const token = dotEnvText === null ? undefined : parseEnv(dotEnvText).meterless_runtime_token?.trim();
  return {
    ...env,
    ...(token && !env.meterless_runtime_token ? { meterless_runtime_token: token } : {}),
    SPECK_HOME_VIEW: env.SPECK_HOME_VIEW || EVIDENCE_HOME_VIEW
  };
}

function accepting(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}

// A Speck answers its brain configuration with { ok, brains }; /api/health
// alone ({ ok }) is too common to identify it.
async function isSpeck(host: string, port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://${host.includes(":") ? `[${host}]` : host}:${port}/api/brains/config`, { signal: AbortSignal.timeout(3_000) });
    const body = await response.json() as { ok?: unknown; brains?: unknown };
    return body.ok === true && typeof body.brains === "object" && body.brains !== null;
  } catch {
    return false;
  }
}

// The process listening on the port, from the operating system's own table.
// On Windows a listening row is the one whose remote address ends in :0, which
// does not depend on the language netstat prints its states in.
function listenerPid(port: number): number | undefined {
  try {
    if (process.platform === "win32") {
      for (const line of execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" }).split(/\r?\n/)) {
        const columns = line.trim().split(/\s+/);
        if (columns[0] === "TCP" && columns[1]?.endsWith(`:${port}`) && columns[2]?.endsWith(":0")) return Number(columns.at(-1)) || undefined;
      }
      return undefined;
    }
    return Number(execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).trim().split(/\s+/)[0]) || undefined;
  } catch {
    return undefined;
  }
}

// Frees the address for a new Speck. Resolves when nothing is listening there;
// throws, having stopped nothing, when the listener is not a Speck or cannot
// be found.
export async function stopRunningSpeck(host: string, port: number, log: (line: string) => void = console.log): Promise<void> {
  if (!await accepting(host, port)) return;
  const where = `http://${host}:${port}`;
  if (!await isSpeck(host, port)) throw new Error(`Port ${port} is in use by something that is not Speck. Stop it, or start Speck on another port with SPECK_PORT.`);
  const pid = listenerPid(port);
  if (!pid || pid === process.pid) throw new Error(`A Speck is already running on ${where}, but its process could not be found. Stop it (Ctrl+C in its terminal) and try again.`);
  log(`A Speck is already running on ${where} (process ${pid}); stopping it to start this one.`);
  process.kill(pid);
  for (let waited = 0; waited < 15_000; waited += 250) {
    if (!await accepting(host, port)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`The Speck on ${where} (process ${pid}) did not stop within 15 s. Stop it (Ctrl+C in its terminal) and try again.`);
}

export function shouldOpenBrowser(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(0|false|no|off)$/i.test(env.SPECK_OPEN_BROWSER?.trim() ?? "");
}

// Opens the address in the default browser with the platform's own opener.
function openBrowser(url: string): void {
  const [command, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true }).on("error", () => {}).unref();
}

// Waits for the Speck it started to answer (up to 2 min), then opens it.
async function openWhenReady(host: string, port: number, speck: { exitCode: number | null }): Promise<void> {
  for (let waited = 0; waited < 120_000 && speck.exitCode === null; waited += 500) {
    if (await isSpeck(host, port)) {
      openBrowser(`http://${host.includes(":") ? `[${host}]` : host}:${port}/`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(ROOT_DIR, "dist", "src", "scripts", "speck.js")) {
  const { host, port } = speckAddress();
  try {
    await stopRunningSpeck(host, port);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  const speck = spawn(process.execPath, ["dist/server.js"], {
    cwd: path.join(ROOT_DIR, "speck"),
    env: speckEnv(process.env, fs.existsSync(path.join(ROOT_DIR, ".env")) ? fs.readFileSync(path.join(ROOT_DIR, ".env"), "utf8") : null),
    stdio: "inherit"
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => speck.kill(signal));
  speck.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  if (shouldOpenBrowser()) void openWhenReady(host, port, speck);
}
