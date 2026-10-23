// What happened in a run, and what a failed request means, said from the
// API's real state. Pure functions; app.js renders them.
//
// Distinctions kept on purpose:
// - a completed run whose conclusion is unresolved is a result, not a failure;
// - a failed assessment leaves records pending to retry; the investigation
//   itself is not failed;
// - an interrupted earlier run is "recovered" only when Speck's beliefs are
//   reconciled with the evidence ledger; until then recovery is incomplete.

// The first meaningful line of a server message, without stack frames, and short.
export function plainMessage(text) {
  const lines = String(text ?? "").split(/\r?\n/).map((line) => line.trim())
    .filter((line) => line && !/^at\s/.test(line) && !/^(org|com|java|scala)\.[\w.$]+(Exception|Error)/.test(line));
  const first = lines[0] ?? "The server gave no message.";
  return first.length > 240 ? `${first.slice(0, 237)}…` : first;
}

// The engine's own progress report, if there is one, with elapsed time.
// Elapsed time is measured by the page from the moment the action started.
export function describeProgress(kind, elapsedMs, progress) {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (kind === "update") return `Introducing the next update… ${seconds} s`;
  if (kind === "reset") return `Starting a fresh copy of the case… ${seconds} s`;
  const engine = progress && progress.maxChunks
    ? ` Execution engine: ${progress.phase}${progress.phaseDetail ? ` (${progress.phaseDetail})` : ""}, chunk ${progress.currentChunk} of at most ${progress.maxChunks}.`
    : "";
  return `Running the investigation… ${seconds} s elapsed.${engine}`;
}

// After a run finished (the request returned): what it did and what to do next.
// view = { status, investigation, listing, trace }.
export function describeRun(view) {
  const run = view.investigation?.latestRun ?? null;
  const current = view.investigation?.current ?? null;
  const pending = view.listing?.pending ?? [];
  if (!run) return null;
  const n = run.runNumber;
  const lines = [];
  let tone = "ok";
  let title;
  const status = run.execution.status;
  if (status === "completed" && !pending.length) {
    title = `Run ${n} completed.`;
  } else if (status === "completed") {
    tone = "warn";
    title = `Run ${n} completed, but ${pending.length} record(s) were not assessed.`;
    lines.push(`No judgment came back for ${pending.join(", ")}, so they stay pending; nothing was guessed for them. They are retried on the next run.`);
  } else if (status === "errored") {
    tone = "warn";
    title = `Run ${n} stopped early: an assessment failed.`;
    if (run.execution.error) lines.push(`Reason: ${plainMessage(run.execution.error)}`);
    lines.push(pending.length
      ? `${pending.join(", ")} stay pending; nothing was guessed for them. Records assessed before the failure still count.`
      : "Every record at this stage was assessed before the failure.");
  } else if (status === "max-chunks") {
    tone = "warn";
    title = `Run ${n} reached its limit of ${run.execution.chunkConfig?.maxChunks ?? "?"} chunks.`;
    lines.push(pending.length ? `${pending.join(", ")} are still pending.` : "Every record at this stage was assessed.");
  } else {
    tone = "warn";
    title = `Run ${n} ended with status "${status}".`;
  }

  if (current) {
    if (current.state === "unresolved") {
      lines.push(`The conclusion is unresolved: ${current.headline} That is a result of the evidence so far, not a failure of the run.`);
    } else {
      lines.push(`Speck's conclusion now: ${current.headline}`);
    }
  }

  // Recovery: only called complete when Speck confirms beliefs match the ledger.
  const latestTrace = [...(view.trace?.entries ?? [])].reverse().find((entry) => entry.kind === "run");
  if (current?.reconciled === false) {
    tone = "warn";
    lines.push("Recovery is incomplete: current beliefs lag the evidence recorded by an interrupted run. Run the investigation again to reconcile them.");
  } else if (latestTrace?.flags?.recovered?.length) {
    lines.push(`This run picked up ${latestTrace.flags.recovered.length} interrupted earlier run(s): what they had recorded was kept, the rest assessed again, and Speck's beliefs are reconciled with its evidence ledger.`);
  }

  let next;
  if (pending.length) next = "Run the investigation again to assess the pending record(s).";
  else if (view.status?.nextStage) next = `Next: introduce the prepared update ("${view.status.nextStage.label}").`;
  else next = "Every prepared update is in. Explore the evidence, the history and the trace, or withdraw a record to see what changes.";
  return { tone, title, lines, next };
}

// A request that failed outright (nothing was recorded for a failed run).
export function describeFailure(kind, error) {
  const body = error?.body ?? {};
  const message = plainMessage(error?.message);
  const action = kind === "run" ? "The investigation did not run" : kind === "update" ? "The update was not introduced" : kind === "reset" ? "The demo case was not reset" : "The request failed";
  if (body.kind === "busy") {
    return { tone: "warn", title: "Something else is still running for this case.", lines: [message], next: "Wait for it to finish, then try again." };
  }
  if (body.kind === "evidence") {
    return { tone: "error", title: `${action}: the evidence could not be read (${body.mode} mode).`, lines: [message, "No run was recorded, and no fallback data was used."],
      next: body.hint ? plainMessage(body.hint) : "Check the evidence source, then try again." };
  }
  if (body.kind === "reasoner") {
    return { tone: "error", title: `${action}: the assessor is not ready.`, lines: [message], next: body.hint ? plainMessage(body.hint) : "Check the assessor's settings, then try again." };
  }
  if (body.kind === "request") {
    return { tone: "error", title: `${action}.`, lines: [message], next: "Check the request and try again." };
  }
  return { tone: "error", title: `${action}: the server reported an error.`, lines: [message],
    next: kind === "reset" ? "The page shows the case as Speck holds it now. Reload, or try the reset again." : "The page shows only what was saved. Try again; if it repeats, check the server's log." };
}
