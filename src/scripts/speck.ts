import { spawn } from "node:child_process";
import path from "node:path";
import { ROOT_DIR } from "../config.js";

// npm run speck
//
// Starts Speck with Evidence Desk as its home view: the interface opens on the
// Evidence tab, which is first in the rail, and Speck's brand button and panel
// close return to it. Speck's other views stay available. Any SPECK_* setting
// in the environment is passed through; SPECK_HOME_VIEW=world restores Speck's
// own default.

export const EVIDENCE_HOME_VIEW = "plugin:evidence-desk:evidence";

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(ROOT_DIR, "dist", "src", "scripts", "speck.js")) {
  const speck = spawn(process.execPath, ["dist/server.js"], {
    cwd: path.join(ROOT_DIR, "speck"),
    env: { ...process.env, SPECK_HOME_VIEW: process.env.SPECK_HOME_VIEW || EVIDENCE_HOME_VIEW },
    stdio: "inherit"
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => speck.kill(signal));
  speck.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}
