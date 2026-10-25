import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setUpEmbeddings } from "../src/scripts/embeddings.js";

// A stand-in Ollama: lists the models it has and answers /api/embed.
async function standIn(models: string[]): Promise<{ url: string; close(): void }> {
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/tags") return res.end(JSON.stringify({ models: models.map((name) => ({ name })) }));
    if (req.url === "/api/embed") return res.end(JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }));
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "evidence-embeddings-"));
const read = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, "model-processors.json"), "utf8"));

test("setup turns on nomic-embed-text on local Ollama, pulling it when missing, and keeps Speck's model processors", async () => {
  const ollama = await standIn([]);
  try {
    const dir = tempDir();
    const processors = [{ id: "meterless", provider: "meterless", model: "meterless/auto", baseUrl: "http://127.0.0.1:8088/v1", enabled: true }];
    fs.writeFileSync(path.join(dir, "model-processors.json"), JSON.stringify({ processors, roles: { worker: "meterless" } }));
    const pulled: string[] = [];
    const message = await setUpEmbeddings({ runtimeDir: dir, ollama: ollama.url, pull: (model) => (pulled.push(model), true) });
    assert.deepEqual(pulled, ["nomic-embed-text"]);
    assert.match(message, /nomic-embed-text on Ollama \(3 dimensions\)/);
    const saved = read(dir);
    assert.deepEqual(saved.processors, processors);
    assert.deepEqual(saved.roles, { worker: "meterless" });
    assert.deepEqual(saved.embedding, { enabled: true, provider: "ollama", baseUrl: ollama.url, model: "nomic-embed-text", dimensions: 3, timeoutMs: 30_000, batchSize: 16, allowHashFallback: true });
  } finally {
    ollama.close();
  }
});

test("setup keeps an encoder already saved in Speck, and changes nothing when Ollama is not answering", async () => {
  const dir = tempDir();
  const kept = { processors: [], roles: {}, embedding: { enabled: true, provider: "ollama", baseUrl: "http://192.168.1.20:11434", model: "nomic-embed-text" } };
  fs.writeFileSync(path.join(dir, "model-processors.json"), JSON.stringify(kept));
  assert.match(await setUpEmbeddings({ runtimeDir: dir, ollama: "http://127.0.0.1:9" }), /kept Speck's saved encoder/);
  assert.deepEqual(read(dir), kept);

  const empty = tempDir();
  assert.match(await setUpEmbeddings({ runtimeDir: empty, ollama: "http://127.0.0.1:9", pull: () => assert.fail("no pull without Ollama") }), /feature-hash encoder/);
  assert.equal(fs.existsSync(path.join(empty, "model-processors.json")), false);
});

test("a fresh install saves Speck's own default processors beside the encoder, and Speck loads it", async () => {
  const ollama = await standIn(["nomic-embed-text:latest"]);
  try {
    const dir = tempDir();
    await setUpEmbeddings({ runtimeDir: dir, ollama: ollama.url, pull: () => assert.fail("already present") });
    const { loadAppConfig } = await import(new URL("../../speck/dist/config.js", import.meta.url).href);
    const config = loadAppConfig({ genesisRuntimePath: dir });
    assert.equal(config.embeddingRuntime.enabled, true);
    assert.equal(config.embeddingRuntime.model, "nomic-embed-text");
    assert.deepEqual(read(dir).processors, config.modelRuntime.processors);
  } finally {
    ollama.close();
  }
});
