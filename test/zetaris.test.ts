import assert from "node:assert/strict";
import { test } from "node:test";
import type { AppConfig } from "../src/config.js";
import { EvidenceProviderError } from "../src/evidence/types.js";
import { ZetarisEvidenceProvider } from "../src/evidence/zetaris-provider.js";
import { createServer } from "../src/server.js";
import { testConfig, withDesk } from "./helpers.js";

const liveConfig = (env: NodeJS.ProcessEnv = {}): AppConfig => testConfig({}, {
  EVIDENCE_MODE: "zetaris", ZETARIS_BASE_URL: "http://zetaris.invalid:3000",
  ZETARIS_USERNAME: "analyst@example.test", ZETARIS_PASSWORD: "placeholder-not-a-secret", ...env
});

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
const fakeFetch = (handler: Handler) => (async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init ?? {})) as typeof fetch;
const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const loginOk = () => jsonResponse(200, { idToken: "test-token", orgId: 7 });

test("live mode surfaces an unreachable Zetaris instead of falling back to fixtures", async () => {
  const refused = fakeFetch(() => { throw new TypeError("fetch failed: connect ECONNREFUSED"); });
  await withDesk(liveConfig(), async (desk) => {
    assert.equal(desk.provider.mode, "zetaris");
    await assert.rejects(desk.listEvidence(), (error: unknown) => {
      assert.ok(error instanceof EvidenceProviderError);
      assert.equal(error.mode, "zetaris");
      assert.match(error.message, /not reachable at http:\/\/zetaris\.invalid:3000/);
      assert.match(error.hint, /docker compose up -d/);
      return true;
    });
    await assert.rejects(desk.run(), EvidenceProviderError);
    assert.equal(desk.runs().length, 0, "a failed fetch records no run and no evidence");
    assert.equal(desk.runtime.mentalObjects.listAll().filter((object) => object.kind === "evidence").length, 0);
  }, { fetchImpl: refused });
});

test("live mode without credentials says which settings are missing", async () => {
  let called = false;
  const provider = new ZetarisEvidenceProvider(liveConfig({ ZETARIS_USERNAME: "", ZETARIS_PASSWORD: "" }).zetaris, fakeFetch(() => { called = true; return loginOk(); }));
  assert.equal(provider.describe().ready, false);
  await assert.rejects(provider.fetchCaseEvidence("DISPUTE-1042"), /missing ZETARIS_USERNAME, ZETARIS_PASSWORD/);
  assert.equal(called, false, "no request is sent without credentials");
});

test("a rejected login and a missing table are reported with actionable hints", async () => {
  const badLogin = new ZetarisEvidenceProvider(liveConfig().zetaris, fakeFetch(() => jsonResponse(401, { msg: "Invalid credentials" })));
  await assert.rejects(badLogin.fetchCaseEvidence("DISPUTE-1042"), (error: unknown) => {
    assert.ok(error instanceof EvidenceProviderError);
    assert.match(error.message, /login as analyst@example\.test failed \(HTTP 401\)/);
    assert.equal(error.detail, "Invalid credentials");
    assert.doesNotMatch(JSON.stringify({ ...error, message: error.message }), /placeholder-not-a-secret/);
    return true;
  });
  const noTable = new ZetarisEvidenceProvider(liveConfig().zetaris, fakeFetch((url) => url.endsWith("/api/auth/login")
    ? loginOk()
    : jsonResponse(400, { msg: "[TABLE_OR_VIEW_NOT_FOUND] The table or view `EVIDENCE_DESK`.`order_events` cannot be found." })));
  await assert.rejects(noTable.fetchCaseEvidence("DISPUTE-1042"), (error: unknown) => {
    assert.ok(error instanceof EvidenceProviderError);
    assert.match(error.hint, /npm run zetaris:seed/);
    assert.match(error.detail ?? "", /TABLE_OR_VIEW_NOT_FOUND/);
    return true;
  });
});

test("Zetaris rows become evidence labelled as retrieved via Zetaris", async () => {
  const requests: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  const provider = new ZetarisEvidenceProvider(liveConfig().zetaris, fakeFetch((url, init) => {
    requests.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    if (url.endsWith("/api/auth/login")) return loginOk();
    const table = /FROM (\S+)/.exec(requests.at(-1)!.body.select)![1];
    const rows = table === "EVIDENCE_DESK.carrier_events" ? [{
      id: "EV-CAR-003", case_id: "DISPUTE-1042", source_system: "carrier", source_name: "Carrier tracking API",
      observed_at: "2026-10-13T03:02:00.000Z", content: "DELIVERED", facts_json: "{\"carrier.status\":\"delivered\"}",
      record_ref: "tracking/7", system_of_record: "Carrier tracking API", author: "driver-app", supersedes: ""
    }] : [];
    return jsonResponse(200, { records: rows, totalCount: rows.length, queryToken: "q-123" });
  }));
  const records = await provider.fetchCaseEvidence("DISPUTE-1042");
  assert.equal(records.length, 1);
  assert.deepEqual(records[0]!.retrieval.mode, "zetaris");
  assert.equal(records[0]!.retrieval.location, "EVIDENCE_DESK.carrier_events");
  assert.equal(records[0]!.retrieval.queryToken, "q-123");
  assert.deepEqual(records[0]!.facts, { "carrier.status": "delivered" });
  const queries = requests.filter((request) => request.url.endsWith("/api/proxy/query/sql/start"));
  assert.equal(queries.length, 4, "one query per configured source table");
  assert.ok(queries.every((query) => query.headers.authorization === "Bearer test-token" && query.headers["x-org-id"] === "7"));
  assert.ok(queries.every((query) => query.body.select.endsWith("WHERE case_id = 'DISPUTE-1042'")));
  await assert.rejects(provider.fetchCaseEvidence("X' OR '1'='1"), /Invalid case id/);
});

test("a run over Zetaris is traced with every SELECT the adapter sent, including empty tables", async () => {
  // The development fixture's rows, served through a stand-in for the Zetaris
  // REST API so the real adapter's login, query and row mapping run. The
  // support table returns no rows: the trace must still show that query.
  const fixture = JSON.parse((await import("node:fs")).readFileSync("fixtures/scenarios/disputed-delivery/evidence.json", "utf8")) as { records: any[] };
  const systems: Record<string, string> = { "EVIDENCE_DESK.order_events": "oms", "EVIDENCE_DESK.warehouse_scans": "wms", "EVIDENCE_DESK.carrier_events": "carrier", "EVIDENCE_DESK.support_messages": "support" };
  let query = 0;
  const zetaris = fakeFetch((url, init) => {
    if (url.endsWith("/api/auth/login")) return loginOk();
    const table = /FROM (\S+)/.exec(JSON.parse(String(init.body)).select)![1]!;
    const rows = systems[table] === "support" ? [] : fixture.records.filter((record) => record.source.system === systems[table]).map((record) => ({
      id: record.id, case_id: record.caseId, source_system: record.source.system, source_name: record.source.name,
      observed_at: record.observedAt, content: record.content, facts_json: JSON.stringify(record.facts), record_ref: record.provenance.recordRef,
      system_of_record: record.provenance.systemOfRecord, author: record.provenance.author, supersedes: record.provenance.supersedes.join(",")
    }));
    query += 1;
    return jsonResponse(200, { records: rows, totalCount: rows.length, queryToken: `token-${query}` });
  });
  await withDesk(liveConfig(), async (desk) => {
    await desk.run();
    const trace = desk.trace().find((entry) => entry.kind === "run")!;
    assert.ok(trace.kind === "run");
    assert.equal(trace.evidence?.mode, "zetaris");
    assert.equal(trace.evidence?.label, "Zetaris Lightning (live)");
    assert.equal(trace.evidence?.target, "http://zetaris.invalid:3000");
    assert.deepEqual(trace.evidence?.sources.map((source) => [source.location, source.rows, source.queryToken]), [
      ["EVIDENCE_DESK.order_events", 1, "token-1"], ["EVIDENCE_DESK.warehouse_scans", 1, "token-2"],
      ["EVIDENCE_DESK.carrier_events", 2, "token-3"], ["EVIDENCE_DESK.support_messages", 0, "token-4"]
    ]);
    assert.ok(trace.evidence!.sources.every((source) => typeof source.latencyMs === "number"));
    // Every record Speck recorded came through those queries.
    const recorded = desk.runs()[0]!.assessed.map((item) => [item.record.id, item.record.retrieval.mode, item.record.retrieval.queryToken]);
    assert.deepEqual(recorded, [["EV-OMS-001", "zetaris", "token-1"], ["EV-WMS-002", "zetaris", "token-2"], ["EV-CAR-003", "zetaris", "token-3"]]);
  }, { fetchImpl: zetaris });
});

test("the API returns a Zetaris failure as a visible 502, not data", async () => {
  const refused = fakeFetch(() => { throw new TypeError("fetch failed"); });
  const config = liveConfig();
  await withDesk(config, async (desk) => {
    const server = createServer(desk, config).listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const { port } = server.address() as { port: number };
      const status = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json() as any;
      assert.equal(status.evidence.mode, "zetaris");
      assert.equal(status.evidence.label, "Zetaris Lightning (live)");
      for (const [method, path] of [["GET", "/api/evidence"], ["POST", "/api/run"]] as const) {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, { method });
        assert.equal(response.status, 502);
        const body = await response.json() as any;
        assert.equal(body.kind, "evidence");
        assert.equal(body.mode, "zetaris");
        assert.ok(body.hint);
        assert.equal(body.records, undefined);
      }
    } finally {
      server.close();
    }
  }, { fetchImpl: refused });
});
