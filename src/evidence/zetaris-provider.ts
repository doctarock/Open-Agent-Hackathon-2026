import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { ZetarisConfig } from "../config.js";
import { byObservation, EvidenceProviderError, validateEvidenceRecord, type EvidenceProvider, type EvidenceRecord, type FetchSummary, type ProviderDescription } from "./types.js";

// Federated evidence through a Zetaris Lightning platform. The REST flow is
// the one the platform's own verify.sh documents: POST /api/auth/login for a
// bearer token and organisation id, then POST /api/proxy/query/sql/start with
// a SELECT. Each source system is a table; config/zetaris-queries.json says
// which. A failure is raised with a hint, never replaced with fixture data.

export interface ZetarisQueryConfig {
  database: string;
  columns: string;
  sources: Array<{ system: string; table: string }>;
}

interface Session { token: string; orgId: string }

const IDENTIFIER = /^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/;
const COLUMN_LIST = /^[A-Za-z0-9_,\s]+$/;
const CASE_ID = /^[A-Za-z0-9_-]+$/;

export class ZetarisEvidenceProvider implements EvidenceProvider {
  readonly mode = "zetaris" as const;
  private session: Session | null = null;
  private fetched: FetchSummary | null = null;

  constructor(private readonly config: ZetarisConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  describe(): ProviderDescription {
    return {
      mode: this.mode,
      label: "Zetaris Lightning (live)",
      target: this.config.baseUrl,
      ready: this.missingSettings().length === 0,
      problem: this.missingSettings().length ? `missing ${this.missingSettings().join(", ")}` : null
    };
  }

  async fetchCaseEvidence(caseId: string): Promise<EvidenceRecord[]> {
    if (!CASE_ID.test(caseId)) throw new EvidenceProviderError(`Invalid case id "${caseId}"`, this.mode, "Case ids may contain only letters, digits, '-' and '_'.");
    const queries = this.queryConfig();
    const records: EvidenceRecord[] = [];
    const sources: FetchSummary["sources"] = [];
    for (const source of queries.sources) {
      const sql = `SELECT ${queries.columns} FROM ${source.table} WHERE case_id = '${caseId}'`;
      const began = performance.now();
      const result = await this.select(sql, source.table);
      sources.push({ location: source.table, rows: result.records.length, queryToken: result.queryToken, latencyMs: Math.round(performance.now() - began) });
      const retrievedAt = new Date().toISOString();
      result.records.forEach((row, index) => {
        const record = this.toRecord(row, `${source.table} row ${index + 1}`);
        if (record.source.system !== source.system) {
          throw new EvidenceProviderError(
            `${source.table} returned a row for source "${record.source.system}", expected "${source.system}"`, this.mode,
            "Check the table mapping in config/zetaris-queries.json.");
        }
        records.push({ ...record, retrieval: { mode: this.mode, location: source.table, retrievedAt, ...(result.queryToken ? { queryToken: result.queryToken } : {}) } });
      });
    }
    this.fetched = { mode: this.mode, at: new Date().toISOString(), sources };
    return records.sort(byObservation);
  }

  // Each SELECT of the last successful fetch, as sent through the platform.
  lastFetch(): FetchSummary | null {
    return this.fetched;
  }

  // One SELECT through the platform. Exposed for the connectivity check.
  async select(sql: string, label = "query"): Promise<{ records: Array<Record<string, unknown>>; queryToken: string | null }> {
    const session = await this.login();
    const response = await this.request(`${this.config.baseUrl}/api/proxy/query/sql/start`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${session.token}`,
        "x-org-id": session.orgId,
        "x-request-id": randomUUID()
      },
      body: JSON.stringify({ select: sql, pageLimit: 1000 })
    }, label);
    const body = await readJson(response);
    if (response.status === 401 || response.status === 403) {
      this.session = null;
      throw new EvidenceProviderError(`Zetaris rejected the query on ${label} (HTTP ${response.status})`, this.mode,
        "The session or account lacks access. Check ZETARIS_USERNAME / ZETARIS_PASSWORD and the account's permissions.", serverMessage(body));
    }
    if (!response.ok) {
      const message = serverMessage(body);
      const missingTable = /TABLE_OR_VIEW_NOT_FOUND/.test(message ?? "");
      throw new EvidenceProviderError(`Zetaris query on ${label} failed (HTTP ${response.status})`, this.mode,
        missingTable
          ? "The table is not registered in Zetaris. Run `npm run zetaris:seed`, or point config/zetaris-queries.json at your own tables."
          : "Read the server message below. A driver that is still starting fails queries; ./verify.sh in the platform folder reports its state.",
        message);
    }
    const records = Array.isArray(body?.records) ? body.records as Array<Record<string, unknown>> : null;
    if (!records) throw new EvidenceProviderError(`Zetaris returned no records array for ${label}`, this.mode, "The API response format was not recognised.", truncate(JSON.stringify(body)));
    const total = Number(body.totalCount ?? records.length);
    if (total > records.length) {
      throw new EvidenceProviderError(`Zetaris returned ${records.length} of ${total} rows for ${label}`, this.mode,
        "Paging beyond 1000 rows is not implemented in this slice. Narrow the query.");
    }
    return { records, queryToken: typeof body.queryToken === "string" ? body.queryToken : null };
  }

  private async login(): Promise<Session> {
    if (this.session) return this.session;
    const missing = this.missingSettings();
    if (missing.length) {
      throw new EvidenceProviderError(`Zetaris live mode is not configured: missing ${missing.join(", ")}`, this.mode,
        "Set these in .env (see .env.example), or set EVIDENCE_MODE=fixture to use local fixtures.");
    }
    const response = await this.request(`${this.config.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: this.config.username, password: this.config.password })
    }, "login");
    const body = await readJson(response);
    const token = typeof body?.idToken === "string" ? body.idToken : null;
    const orgId = this.config.orgId ?? (body?.orgId !== undefined && body?.orgId !== null ? String(body.orgId) : null);
    if (!response.ok || !token) {
      throw new EvidenceProviderError(`Zetaris login as ${this.config.username} failed (HTTP ${response.status})`, this.mode,
        "Check ZETARIS_USERNAME and ZETARIS_PASSWORD. On a fresh platform the account exists only once the driver has finished its first start.",
        serverMessage(body));
    }
    if (!orgId) throw new EvidenceProviderError("Zetaris login returned no orgId", this.mode, "Set ZETARIS_ORG_ID explicitly.");
    this.session = { token, orgId };
    return this.session;
  }

  private async request(url: string, init: RequestInit, label: string): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.config.timeoutMs) });
    } catch (error) {
      const reason = error instanceof Error ? (error.name === "TimeoutError" ? `timed out after ${this.config.timeoutMs} ms` : error.message) : String(error);
      throw new EvidenceProviderError(`Zetaris is not reachable at ${this.config.baseUrl} (${label}: ${reason})`, this.mode,
        "Start the platform (`docker compose up -d` in the zetaris-platform folder, then ./verify.sh), or check ZETARIS_BASE_URL.");
    }
  }

  private queryConfig(): ZetarisQueryConfig {
    let parsed: ZetarisQueryConfig;
    try {
      parsed = JSON.parse(fs.readFileSync(this.config.queryConfigPath, "utf8")) as ZetarisQueryConfig;
    } catch (error) {
      throw new EvidenceProviderError(`Cannot read Zetaris query config ${this.config.queryConfigPath}`, this.mode,
        "Set ZETARIS_QUERY_CONFIG to a JSON file shaped like config/zetaris-queries.json.", error instanceof Error ? error.message : String(error));
    }
    if (!COLUMN_LIST.test(parsed.columns ?? "") || !parsed.sources?.length
      || parsed.sources.some((source) => !IDENTIFIER.test(source.table) || !source.system)) {
      throw new EvidenceProviderError("Zetaris query config is invalid", this.mode,
        "Each source needs a system and a DATABASE.table name; columns must be a plain column list.");
    }
    return parsed;
  }

  private toRecord(row: Record<string, unknown>, where: string): Omit<EvidenceRecord, "retrieval"> {
    try {
      const text = (key: string) => (row[key] === null || row[key] === undefined ? "" : String(row[key]));
      const facts = text("facts_json") ? JSON.parse(text("facts_json")) : {};
      return validateEvidenceRecord({
        id: text("id"), caseId: text("case_id"),
        source: { system: text("source_system"), name: text("source_name") },
        observedAt: text("observed_at"), content: text("content"), facts,
        provenance: {
          systemOfRecord: text("system_of_record"), recordRef: text("record_ref"), author: text("author"),
          supersedes: text("supersedes").split(",").map((id) => id.trim()).filter(Boolean)
        }
      }, where);
    } catch (error) {
      throw new EvidenceProviderError(`Zetaris row could not be read as evidence (${where})`, this.mode,
        "The table's columns must match config/zetaris-queries.json.", error instanceof Error ? error.message : String(error));
    }
  }

  private missingSettings(): string[] {
    return [
      ...(this.config.baseUrl ? [] : ["ZETARIS_BASE_URL"]),
      ...(this.config.username ? [] : ["ZETARIS_USERNAME"]),
      ...(this.config.password ? [] : ["ZETARIS_PASSWORD"])
    ];
  }
}

async function readJson(response: Response): Promise<any> {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return { msg: text }; }
}

function serverMessage(body: any): string | null {
  const message = typeof body?.msg === "string" ? body.msg : typeof body?.message === "string" ? body.message : null;
  return message ? truncate(message) : null;
}

function truncate(text: string, length = 600): string {
  return text.length > length ? `${text.slice(0, length)}…` : text;
}
