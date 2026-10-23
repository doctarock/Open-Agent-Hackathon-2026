import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { loadConfig, ROOT_DIR } from "../src/config.js";

test(".env and local data are ignored by git", () => {
  for (const file of [".env", ".env.local", "data/evidence-desk.sqlite"]) {
    const output = execFileSync("git", ["check-ignore", file], { cwd: ROOT_DIR, encoding: "utf8" }).trim();
    assert.equal(output, file);
  }
  assert.throws(() => execFileSync("git", ["check-ignore", ".env.example"], { cwd: ROOT_DIR, stdio: "pipe" }), ".env.example must be committed");
});

test("configuration needs no secrets and has no credential defaults", () => {
  const config = loadConfig({});
  assert.equal(config.evidenceMode, "fixture");
  assert.equal(config.reasoner, "rules");
  assert.equal(config.zetaris.username, "");
  assert.equal(config.zetaris.password, "");
  // The default provider is a Meterless Runtime on this machine, with no token.
  assert.deepEqual([config.nemotron.provider, config.nemotron.baseUrl, config.nemotron.model], ["meterless", "http://127.0.0.1:8088/v1", "meterless/auto"]);
  assert.equal(config.nemotron.apiKey, "");
  assert.equal(loadConfig({ MODEL_PROVIDER: "openai-compatible" }).nemotron.baseUrl, "");
  assert.equal(loadConfig({ MODEL_PROVIDER: "nvidia" }).nemotron.apiKey, "");
  assert.throws(() => loadConfig({ EVIDENCE_MODE: "live" }), /EVIDENCE_MODE must be one of fixture, zetaris/);
});

test(".env.example holds placeholders only", () => {
  const example = fs.readFileSync(path.join(ROOT_DIR, ".env.example"), "utf8");
  const values = Object.fromEntries(example.split(/\r?\n/).filter((line) => /^[A-Za-z_]+=/.test(line)).map((line) => line.split(/=(.*)/s).slice(0, 2)));
  for (const key of ["ZETARIS_USERNAME", "ZETARIS_PASSWORD", "NEMOTRON_API_KEY", "meterless_runtime_token"]) assert.match(values[key] ?? "", /^<.+>$/, `${key} must be a placeholder`);
});

test("no credential-shaped strings in the project's own files", () => {
  const skip = new Set(["node_modules", "dist", "data", "speck", ".git"]);
  // Assembled from pieces so this file does not match itself: an NVIDIA API
  // key, the local Zetaris bundle's documented default password, a JWT.
  const patterns = [["nvapi", "-[A-Za-z0-9_-]{20,}"], ["Zetaris", "1@"], ["eyJ", "[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{20,}\\."]]
    .map((parts) => new RegExp(parts.join("")));
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name) || entry.name === ".env") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (patterns.some((pattern) => pattern.test(fs.readFileSync(full, "utf8")))) offenders.push(path.relative(ROOT_DIR, full));
    }
  };
  walk(ROOT_DIR);
  assert.deepEqual(offenders, []);
});
