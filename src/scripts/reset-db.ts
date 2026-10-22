import fs from "node:fs";
import path from "node:path";
import { loadConfig, loadDotEnv } from "../config.js";

// Deletes Evidence Desk's Speck database (and its WAL files, learned model
// competence, and Meterless run history) so the next start is a clean case.
// Stop the server first: an open database cannot be removed on Windows.

loadDotEnv();
const config = loadConfig();
const dataDir = path.dirname(config.databasePath);
const targets = [
  config.databasePath, `${config.databasePath}-wal`, `${config.databasePath}-shm`,
  path.join(dataDir, "processor-competence.json"), config.historyDir
];
let failed = false;
for (const target of targets) {
  if (!fs.existsSync(target)) continue;
  try {
    fs.rmSync(target, { recursive: true, force: true });
    console.log(`removed ${path.relative(config.rootDir, target)}`);
  } catch (error) {
    failed = true;
    console.error(`could not remove ${path.relative(config.rootDir, target)}: ${error instanceof Error ? error.message : error}`);
  }
}
if (failed) {
  console.error("Is the Evidence Desk server still running? Stop it and run `npm run db:reset` again.");
  process.exit(1);
}
console.log(`Clean database: ${path.relative(config.rootDir, config.databasePath)} will be created on next start.`);
