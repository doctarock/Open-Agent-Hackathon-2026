import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT_DIR } from "../config.js";

// npm run plugin:install
//
// Installs Evidence Desk as a Speck plugin: speck/plugins/evidence-desk/,
// the only place Speck loads plugins from.
//   dist/       the compiled engine and plugin entry; each "#speck" import is
//               pointed at Speck's own dist/index.js by absolute file URL, so
//               the plugin shares the module instances of the Speck server it
//               runs in, and still loads when Speck's tests copy plugins/
//               elsewhere (reinstall if the repository moves)
//   fixtures/, eval/scenarios/, config/   the cases' data
//   public/app.js, tour.js, status.js, style.css, plugin/ui/   the tab's page
//   .env, data/  kept from an earlier install (settings, Meterless history)
// Then it approves the plugin in Speck's allowlist
// (speck/plugins/.runtime/plugin-trust.json), as Speck's plugin README asks
// after reviewing a plugin change. Restart Speck to load it.

export const SPECK_DIR = path.join(ROOT_DIR, "speck");
const PLUGIN_ID = "evidence-desk";
const ENTRY = path.join("dist", "plugin", `${PLUGIN_ID}-plugin.js`);

// settingsFile: the .env seeded into a first install (default: the repository's).
export function installPlugin(options: { rootDir?: string; speckDir?: string; settingsFile?: string } = {}): { target: string; entryHash: string; settings: string } {
  const rootDir = options.rootDir ?? ROOT_DIR;
  const speckDir = options.speckDir ?? SPECK_DIR;
  const settingsFile = options.settingsFile ?? path.join(rootDir, ".env");
  const target = path.join(speckDir, "plugins", PLUGIN_ID);
  const speckIndex = path.join(speckDir, "dist", "index.js");
  if (!fs.existsSync(speckIndex)) throw new Error(`Speck is not built (${speckIndex} is missing). Run npm run setup.`);
  if (!fs.existsSync(path.join(rootDir, ENTRY))) throw new Error(`The plugin is not built (${ENTRY} is missing). Run npm run build.`);

  // Replace everything but the settings and the cases' data.
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(target)) {
    if (entry === ".env" || entry === "data") continue;
    fs.rmSync(path.join(target, entry), { recursive: true, force: true });
  }

  for (const part of ["src", "vendor", "plugin"]) {
    copyTree(path.join(rootDir, "dist", part), path.join(target, "dist", part), (file) => !file.endsWith(".map"));
  }
  const specifier = pathToFileURL(speckIndex).href;
  for (const file of walk(path.join(target, "dist"))) {
    if (!file.endsWith(".js")) continue;
    const source = fs.readFileSync(file, "utf8");
    const rewritten = source.replace(/(["'])#speck\1/g, `"${specifier}"`);
    if (rewritten !== source) fs.writeFileSync(file, rewritten);
  }
  for (const part of ["fixtures", path.join("eval", "scenarios"), "config", path.join("plugin", "ui")]) {
    copyTree(path.join(rootDir, part), path.join(target, part));
  }
  for (const file of ["app.js", "tour.js", "status.js", "style.css"]) {
    fs.mkdirSync(path.join(target, "public"), { recursive: true });
    fs.copyFileSync(path.join(rootDir, "public", file), path.join(target, "public", file));
  }

  // Settings: the standalone .env, on first install only. Never printed.
  let settings = "kept the plugin's existing .env";
  if (!fs.existsSync(path.join(target, ".env"))) {
    if (fs.existsSync(settingsFile)) {
      fs.copyFileSync(settingsFile, path.join(target, ".env"));
      settings = "copied .env from the repository (git-ignored in both repositories)";
    } else {
      settings = "no .env: the cases run on fixtures with the rule assessor (copy .env.example to speck/plugins/evidence-desk/.env to configure)";
    }
  }

  const entryHash = createHash("sha256").update(fs.readFileSync(path.join(target, ENTRY))).digest("hex");
  const trustFile = path.join(speckDir, "plugins", ".runtime", "plugin-trust.json");
  const trust = fs.existsSync(trustFile) ? JSON.parse(fs.readFileSync(trustFile, "utf8")) as { allowlist?: Record<string, unknown>; mode?: string } : { mode: "allowlist", allowlist: {} };
  trust.allowlist = { ...(trust.allowlist ?? {}), [PLUGIN_ID]: { hashes: [entryHash] } };
  fs.mkdirSync(path.dirname(trustFile), { recursive: true });
  fs.writeFileSync(trustFile, `${JSON.stringify(trust, null, 1)}\n`);
  return { target, entryHash, settings };
}

function copyTree(from: string, to: string, include: (file: string) => boolean = () => true): void {
  for (const file of walk(from)) {
    if (!include(file)) continue;
    const destination = path.join(to, path.relative(from, file));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(file, destination);
  }
}

function walk(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(ROOT_DIR, "dist", "src", "scripts", "plugin-install.js")) {
  const result = installPlugin();
  console.log(`Installed Evidence Desk into ${path.relative(ROOT_DIR, result.target)}`);
  console.log(`  settings: ${result.settings}`);
  console.log(`  approved in Speck's plugin allowlist: evidence-desk ${result.entryHash}`);
  console.log("Restart Speck (npm run speck) to load it; the Evidence tab appears in Speck's rail.");
}
