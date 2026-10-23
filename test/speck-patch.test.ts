import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ROOT_DIR } from "../src/config.js";

// This project's change to Speck is a patch kept here (patches/), applied to
// the speck/ working tree by npm run speck:patch, never committed to Speck.

const patch = path.join(ROOT_DIR, "patches", "speck-home-view.patch");
const git = (...args: string[]) => execFileSync("git", ["-C", path.join(ROOT_DIR, "speck"), ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

test("the project's Speck patch is applied to the working tree, on top of the pinned upstream commit", () => {
  git("apply", "--check", "--reverse", patch);
  assert.match(execFileSync("git", ["-C", ROOT_DIR, "submodule", "status", "speck"]).toString(), /^.29d5bb3/, "the submodule stays pinned to upstream Speck");
});

test("the patch touches only the home-view change, never Speck's plugin trust or plugins", () => {
  const files = [...fs.readFileSync(patch, "utf8").matchAll(/^diff --git a\/(\S+) b\//gm)].map((match) => match[1]).sort();
  assert.deepEqual(files, ["README.md", "public/index.html", "public/speck.js", "public/ui/core.js", "public/ui/workspace.js", "src/config.ts", "src/genesis-host.ts", "src/tests/genesis-host.test.ts"]);
});
