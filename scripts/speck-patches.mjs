// npm run speck:patch
//
// Applies this project's own changes to Speck (patches/*.patch) to the speck/
// submodule's working tree. They belong to this project only: they are never
// committed to Speck, and the submodule stays pinned to upstream Speck.
// Idempotent: a patch already in the tree is left alone. Plain JavaScript,
// because it runs before anything is built (npm run setup builds Speck after it).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const speck = path.join(root, "speck");
const patchDir = path.join(root, "patches");

const git = (...args) => execFileSync("git", ["-C", speck, ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const applies = (...args) => {
  try { git("apply", "--check", ...args); return true; } catch { return false; }
};

if (!fs.existsSync(path.join(speck, "package.json"))) {
  console.error("speck/ is not checked out. Run: git submodule update --init --recursive");
  process.exit(1);
}
const head = git("rev-parse", "--short", "HEAD");
for (const name of fs.readdirSync(patchDir).filter((file) => file.endsWith(".patch")).sort()) {
  const file = path.join(patchDir, name);
  if (applies("--reverse", file)) {
    console.log(`${name}: already applied to speck (${head})`);
  } else if (applies(file)) {
    git("apply", file);
    console.log(`${name}: applied to speck (${head})`);
  } else {
    console.error(`${name} does not apply to speck at ${head}. The patches apply to upstream Speck 29d5bb3 and 8821789 (its lockfile update); if the pin moved, update the patch.`);
    process.exit(1);
  }
}
