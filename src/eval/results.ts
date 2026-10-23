import fs from "node:fs";
import path from "node:path";

// Writing a report under eval/results/ never loses the previous one: before
// a report is replaced, the existing file is copied to eval/results/history/
// under its own timestamp (the generatedAt it records, or its modification
// time), unless an identical copy is already there. The latest report keeps
// its usual name, so the page and the documentation find it.
export function writeReport(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const previous = fs.readFileSync(file, "utf8");
    if (previous !== content) {
      let stamp: string;
      try {
        stamp = (JSON.parse(previous) as { generatedAt?: string }).generatedAt ?? "";
      } catch {
        stamp = "";
      }
      stamp ||= fs.statSync(file).mtime.toISOString();
      const extension = path.extname(file);
      const archive = path.join(path.dirname(file), "history", `${path.basename(file, extension)}-${stamp.replace(/[:.]/g, "-")}${extension}`);
      fs.mkdirSync(path.dirname(archive), { recursive: true });
      if (!fs.existsSync(archive)) fs.copyFileSync(file, archive);
    }
  }
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, content);
  fs.renameSync(temporary, file);
}
