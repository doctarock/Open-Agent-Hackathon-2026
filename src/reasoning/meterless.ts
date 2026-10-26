import { autoDetectMeterless as speckAutoDetect, meterlessHeaders as speckHeaders, probeMeterless as speckProbe, type MeterlessProbe } from "#speck";

// Meterless Runtime (1.4, provider contract v4) as the model provider: an
// OpenAI-compatible endpoint whose model ids are routing modes, not models,
// or a model it lists by name (a pinned model, such as Evidence Desk's
// default, Nemotron 3.5 Bolt E4B).
// Why the contract lives in Speck and is re-exported here: Speck's own chat
// and Evidence Desk then reach the Runtime through the same code, so the two
// cannot disagree about tokens, headers or routing modes. Evidence Desk adds
// only its own app id, so the Runtime can tell its calls apart.
// The contract is implemented once, in Speck (speck/src/models/meterless.ts,
// added by patches/speck-meterless-provider.patch); this file gives Evidence
// Desk's calls their own app id. The engine that executes each run is the
// vendored Meterless Markovian engine (vendor/meterless-markovian/); this file
// is only about where model calls go.

export {
  describeMeterlessModel, isMeterlessModel, isMeterlessPinnedModel, isMeterlessTarget, METERLESS_AUTO_DETECT_HOSTS as AUTO_DETECT_HOSTS, METERLESS_AUTO_DETECT_PORTS as AUTO_DETECT_PORTS,
  METERLESS_DEFAULT_BASE_URL, METERLESS_DEFAULT_MODEL, METERLESS_DISPOSITIONS, METERLESS_NAME, METERLESS_TIMEOUT_MS,
  METERLESS_TOKEN_HANDLE as METERLESS_TOKEN_KEY, normaliseMeterlessUrl, parseMeterlessConnectLink as parseConnectLink, usableMeterlessToken as usableToken
} from "#speck";
export type { MeterlessProbe, MeterlessStatus } from "#speck";

// The model Evidence Desk asks Nightshift for unless METERLESS_MODEL says
// otherwise. Why a pinned model, not a routing mode: in meterless/auto the
// runtime chose 30B and 550B Nemotrons, so results could not be tied to one
// model; a pinned small Nemotron gives every assessor and baseline call the
// same model, and the response names it.
export const EVIDENCE_DESK_METERLESS_MODEL = "nvidia/nemotron-3.5-bolt-e4b";

// Sent as meterless-app on every request Evidence Desk makes.
export const METERLESS_APP_ID = "evidence-desk";

export const meterlessHeaders = (token: string, options: { chat?: boolean } = {}) => speckHeaders(token, { ...options, app: METERLESS_APP_ID });

export const probeMeterless = (baseUrl: string, token: string, timeoutMs?: number): Promise<MeterlessProbe> =>
  speckProbe(baseUrl, token, { app: METERLESS_APP_ID, ...(timeoutMs ? { timeoutMs } : {}) });

export const autoDetectMeterless = (token: string, candidates?: string[]): Promise<MeterlessProbe | null> =>
  speckAutoDetect(token, { app: METERLESS_APP_ID, ...(candidates ? { candidates } : {}) });
