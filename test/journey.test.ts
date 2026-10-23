import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { ROOT_DIR } from "../src/config.js";

// The guided demo inside Speck (public/journey.js): both prepared cases, then
// Speck's own views, then an investigation of the person's own.

const journey = await import(pathToFileURL(path.join(ROOT_DIR, "public", "journey.js")).href) as any;
const tour = await import(pathToFileURL(path.join(ROOT_DIR, "public", "tour.js")).href) as any;
const text = (items: unknown[]): string => items.flat(Infinity).filter(Boolean).join("\n");
const part = (id: string) => journey.JOURNEY.find((item: any) => item.id === id);

test("the demo runs both prepared cases (the bank return first, each opening on the side-by-side comparison), then Speck's world view, memory map and chat, then the person's own investigation", () => {
  assert.deepEqual(journey.JOURNEY.map((item: any) => item.id), ["bank", "delivery", "world", "memory", "chat", "create"]);
  assert.deepEqual([part("bank").caseId, part("delivery").caseId], ["bank-return", "disputed-delivery"]);
  const known = new Set(tour.TOUR_STEPS.map((step: any) => step.id));
  for (const item of journey.JOURNEY.filter((entry: any) => entry.kind === "case")) {
    for (const id of item.steps) assert.ok(known.has(id), `${item.id}: ${id} is a step of the case tour`);
    for (const action of ["compare", "run", "update", "rerun"]) assert.ok(item.steps.includes(action), `${item.id} has the ${action} step`);
  }
  assert.ok(part("bank").steps.includes("changed"), "the bank return shows its correction");
});

test("the Speck parts describe real state, and the action parts wait for it", () => {
  const facts = { cases: [{ id: "disputed-delivery", label: "Disputed delivery", runs: 2, headline: "Leading, not established: H-MISDELIVERED." }, { id: "bank-return", label: "Bank return", runs: 0, headline: "" }],
    timeline: "Timeline · 12 of 50 items", memory: "40 mapped memories · 18 associations", replied: false };
  assert.match(text(part("world").body(facts)), /Disputed delivery: 2 run\(s\); now Leading.*\nBank return: not run yet\./s);
  assert.match(text(part("world").body(facts)), /Speck reports: Timeline · 12 of 50 items/);
  assert.match(text(part("memory").body(facts)), /derived from.*supports, or contradicts.*inhibits.*40 mapped memories/s);

  assert.equal(journey.partDone(part("world"), facts), true, "a part without an action is done once shown");
  assert.equal(journey.partDone(part("chat"), facts), false);
  assert.equal(journey.partDone(part("chat"), { ...facts, replied: true }), true);
  assert.match(text(part("chat").body(facts)), new RegExp(journey.SUGGESTED_QUESTION.replace(/[?,]/g, "\\$&")));
  assert.equal(journey.partDone(part("create"), facts), true, "the last part does not wait for the person to create anything");
  assert.match(text(part("create").body(facts)), /That completes the guided demo/);
});

test("where the demo is is kept per viewer, and survives unavailable storage", () => {
  const map = new Map<string, string>();
  const storage = { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => void map.set(key, value) };
  const store = journey.journeyStore(storage);
  assert.equal(store.part(), null);
  store.setPart(3);
  assert.equal(journey.journeyStore(storage).part(), 3);
  store.setPart(99);
  assert.equal(store.part(), null, "an out-of-range part is ignored");
  const broken = journey.journeyStore({ getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
  broken.setPart(1);
  assert.equal(broken.part(), null);
  assert.equal(broken.offerDismissed(), false);
});
