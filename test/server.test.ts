import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { createServer } from "../src/server.js";
import { testConfig, withDesk } from "./helpers.js";

// The standalone server has no login, so it answers only its own page and
// local tools: not another site in the same browser, nor a domain rebound to
// 127.0.0.1.

// One request with the given headers (fetch cannot set Host).
function request(port: number, method: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("the server refuses other sites and rebound domains, and answers its own page and local tools", async () => {
  const config = testConfig();
  await withDesk(config, async (desk) => {
    const server = createServer(desk, config).listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      // A cross-site POST, as a page elsewhere would send it.
      const crossSite = await request(port, "POST", "/api/reset", { origin: "http://evil.example", "content-type": "text/plain" });
      assert.equal(crossSite.status, 403);
      assert.equal(desk.runs().length, 0);
      // A domain re-resolved to this machine sends its own name as Host.
      assert.equal((await request(port, "GET", "/api/status", { host: `attacker.example:${port}` })).status, 403);
      // This server's own page, by IP or localhost, and a tool with no Origin.
      assert.equal((await request(port, "GET", "/api/status", { origin: `http://127.0.0.1:${port}` })).status, 200);
      assert.equal((await request(port, "GET", "/api/status", { host: `localhost:${port}`, origin: `http://localhost:${port}` })).status, 200);
      assert.equal((await request(port, "GET", "/api/status")).status, 200);
      // A malformed path parameter is the request's fault, not the server's.
      const malformed = await request(port, "GET", "/api/comparison/%E0%A4%A");
      assert.equal(malformed.status, 400);
      assert.equal(malformed.body.kind, "request");
    } finally {
      server.close();
    }
  });
});
