# Phase 0 — Speck import report

## 1. Source repository and imported commit

| Item | Value |
|---|---|
| Source | https://github.com/doctarock/Speck |
| Imported commit | `7d6a2228191888e5ec696868d592eacb3f427d42` |
| Subject | Speck: stable release of the gated default path |
| Branch | `main` (`origin/main`) |
| Tags | none |
| Package | `speck@0.13.0` |

## 2. Import method and Git state

The hackathon workspace was **not empty**. It already had a Git repository:

- Remote: `https://github.com/doctarock/Open-Agent-Hackathon-2026.git`
- Branch: `main`, clean, matching `origin/main`
- HEAD: `4873054d5d7fb0629a4ca1576adade55af76556e` — Initial commit (`LICENSE`, `README.md`)

**Speck is imported as a Git submodule dependency** at `speck/`, not merged into this repository. Speck keeps its own history, `main` branch, and origin. The parent repo keeps its initial commit and files unchanged.

An earlier attempt merged Speck's history into this repo. That merge was **reset** (`git reset --hard origin/main`) before the submodule import. It was never pushed.

| Repo | HEAD | Working tree |
|---|---|---|
| Parent (`Open-Agent-Hackathon-2026`) | `4873054` `main` | Staged, uncommitted: `.gitmodules`, `speck` gitlink |
| Submodule (`speck/`) | `7d6a222` `main` | Clean (install artifacts are gitignored) |

`.gitmodules`:

```
[submodule "speck"]
	path = speck
	url = https://github.com/doctarock/Speck.git
```

Clone for later checkouts:

```powershell
git clone --recurse-submodules https://github.com/doctarock/Open-Agent-Hackathon-2026.git
# or, after clone:
git submodule update --init --recursive
```

The submodule pin is staged locally and **not committed** yet.

## 3. Runtime and dependency requirements

From Speck's README, `package.json`, and `src/config.ts`.

### Required for install and unit tests

- Node.js 22 (`engines`: `>=18`; README: Node.js 22). Verified: **v22.14.0**, npm **10.9.2**.
- npm lockfile install (`package-lock.json`). Dependencies include `better-sqlite3`, `express`, `three`, `@fontsource/manrope`, and `genesis-runtime` via `file:vendor/genesis-runtime`.

### Required for the documented live default path

- **Ollama** at `http://127.0.0.1:11434`. Verified: **0.40.6**, serving.
- Answering/routing model: **`qwen3:4b`**. Present locally.
- Example/fact reader: **`LiquidAI/lfm2.5-1.2b-instruct:q8_0`**. Present locally.
- First live run used `SPECK_OLLAMA_MODEL=qwen3:4b` because no saved `data/genesis-runtime/model-processors.json` existed yet. That env var creates a single Ollama processor and assigns it to all roles.

### Optional / degraded without

| Service | Purpose | This machine |
|---|---|---|
| Embedding (`nomic-embed-text` via Ollama or llama.cpp) | Memory; hash fallback if disabled | Model present; embedding not enabled unless `SPECK_EMBEDDING_ENABLED` |
| NLI sidecar (`sidecars/nli`, port 8765) | Qualification / paired entailment | Running; DeBERTa-v3-large loaded on CUDA |
| Parse sidecar (`sidecars/parse`, port 8766, spaCy `en_core_web_sm`) | Deterministic negation/parse | Running; `en_core_web_sm/3.8.0` |
| Playwright service (default `http://127.0.0.1:39005`) | Named web pages | **Not running** |

Python 3.10.11, spaCy 3.8.16, torch 2.5.1+cu121, transformers 4.57.3 were present; sidecars were already up and were not started by this import.

### Environment variables (non-exhaustive)

`SPECK_OLLAMA_MODEL`, `SPECK_OLLAMA_BASE_URL`, `SPECK_DISABLE_DEFAULT_MODEL`, `SPECK_DB_PATH`, `SPECK_GENESIS_RUNTIME_PATH`, `SPECK_GENESIS_PROFILE`, `SPECK_PORT` / `PORT`, `SPECK_HOST`, `SPECK_PLUGIN_IMPORT_MODE`, `SPECK_MODEL_ROUTING`, `SPECK_EMBEDDING_*`, `SPECK_BROWSER_*`, `SPECK_PARSE_URL`, `SPECK_WORKING_MEMORY_CAPACITY`, `SPECK_RECOVER_INTERRUPTED`. Persistence under `data/` (gitignored).

## 4. Setup and execution commands

All commands run inside `speck/`.

```powershell
cd speck
npm ci
npm run build
npm test
$env:SPECK_OLLAMA_MODEL = "qwen3:4b"
node dist/cli.js chat "Hello"   # one message on the default path
node dist/server.js             # UI at http://127.0.0.1:4310
```

Lockfile was not regenerated. `npm ci` used the existing `package-lock.json`.

## 5. Test results and blockers

### Commands executed

| Command | Result |
|---|---|
| `npm ci` (in `speck/`) | 175 packages, 0 vulnerabilities |
| `npm test` (`tsc` then `node --test dist/tests/*.test.js`) | **228 passed, 0 failed**, ~1.1 s after compile |
| `SPECK_OLLAMA_MODEL=qwen3:4b node dist/cli.js chat "Hello"` | Success, `path: "plain"`, reply in 6191 ms |
| `SPECK_PORT=4311 node dist/server.js` | `listening on http://127.0.0.1:4311` |
| `GET /` | 200, `<title>Speck</title>` |
| `GET /api/runtime/status` | 200, `coreVersion: 0.13.0`, worker model `qwen3:4b` |

The HTTP server was started only for verification and then stopped. The CLI used `SPECK_DB_PATH=speck/data/speck-import-verify.sqlite` (gitignored).

### Live default path

A real end-to-end CLI turn **succeeded** against local Ollama (`qwen3:4b`):

```json
{
  "reply": "Hello! 😊 How can I assist you today?",
  "path": "plain",
  "latencyMs": 6191
}
```

The unit suite does not require a live model; those tests mock inference.

### Limitations (environment, not Speck defects)

- No saved model-processors file at import time; live chat/server needed `SPECK_OLLAMA_MODEL`.
- Playwright browser service was not available, so the web-page component cannot run live.
- NLI/parse sidecars were already running here; a clean machine would need them only for qualification/paired-entailment, not for `npm test` or `chat "Hello"`.
- Speck source was not modified. No lockfile or architecture changes.

## 6. Recommended next step

1. **Commit the parent-repo submodule pin** (`.gitmodules` and `speck` at `7d6a222`) when you want this import recorded on `main`.
2. Then start hackathon Phase 1 against `speck/` as the dependency. Do not change Speck's cognitive architecture, model configuration, or benchmark code until that phase says to.
)
