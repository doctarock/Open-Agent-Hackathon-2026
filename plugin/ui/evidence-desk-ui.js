// The Evidence tab in Speck's interface. Speck mounts it; it shows the same
// page as the standalone Evidence Desk (public/app.js), styled with Speck's
// palette, for whichever case is selected, and the form for starting an
// investigation of the person's own. Requests go through Speck's
// admin-authorised fetch, as Speck requires for plugin routes.
//
// It also runs the guided demo (public/journey.js): both prepared cases, then
// Speck's world view, memory map and chat, then an investigation of the
// person's own. Speck mounts the tab afresh each time its view opens, and the
// demo continues into Speck's own views, so the demo's state lives in this
// module and in browser storage, not in one mount.

const ASSET_BASE = "/plugins/evidence-desk";
const API_BASE = "/api/plugins/evidence-desk";

function ensureStylesheet() {
  if (document.querySelector("link[data-evidence-desk]")) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `${ASSET_BASE}/style.css`;
  link.dataset.evidenceDesk = "";
  document.head.append(link);
}

function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "className") node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const remember = (key, value) => { try { localStorage.setItem(`edk:tab:${key}`, value); } catch { /* not kept */ } };
const recall = (key) => { try { return localStorage.getItem(`edk:tab:${key}`); } catch { return null; } };
const storage = () => { try { return window.localStorage; } catch { return null; } };

// ----- The guided demo, across mounts -----

const demo = {
  journey: null,     // public/journey.js, once loaded
  store: null,
  tab: null,         // the tab currently mounted (its show/openNewCase)
  fetcher: fetch,
  start: "resume",   // how the next case part opens
  coach: null,
  collapsed: false,
  spotlit: null,
  mounted: false,    // whether the tab has been mounted since the page loaded
  facts: { cases: [], timeline: "", memory: "", replied: false }
};

const currentPart = () => {
  const index = demo.store?.part() ?? null;
  return index === null ? null : demo.journey.JOURNEY[index];
};

// Speck's own furniture, found by what Speck's page renders.
const host = {
  evidenceButton: () => document.querySelector('.rail-button[data-view^="plugin:evidence-desk:"]'),
  evidenceOpen: () => Boolean(host.evidenceButton()?.classList.contains("active")),
  worldOpen: () => document.querySelector("#worldView")?.hidden === false,
  openWorld(mode) {
    if (!host.worldOpen()) document.querySelector('.rail-button[data-view="world"]')?.click();
    document.querySelector(`[data-world-mode="${mode}"]`)?.click();
  }
};

function hostSpotlight(target) {
  demo.spotlit?.classList.remove("edk-host-spotlight");
  demo.spotlit = target ?? null;
  demo.spotlit?.classList.add("edk-host-spotlight");
}

// What the Speck-side parts describe, read from real state: each prepared
// case's investigation through the plugin's API, and what Speck's world view
// reports about itself.
async function gatherFacts() {
  const prepared = (demo.tab?.cases() ?? []).filter((item) => item.kind !== "yours");
  demo.facts.cases = await Promise.all(prepared.map(async (item) => {
    try {
      const response = await demo.fetcher(`${API_BASE}/cases/${encodeURIComponent(item.id)}/investigation`);
      const investigation = await response.json();
      return { id: item.id, label: item.label, runs: investigation.runs?.length ?? 0, headline: investigation.current?.headline ?? "" };
    } catch {
      return { id: item.id, label: item.label, runs: 0, headline: "" };
    }
  }));
  demo.facts.timeline = document.querySelector("#timelineStatus")?.textContent.trim() ?? "";
  demo.facts.memory = document.querySelector(".world-stage.memory-mode") ? document.querySelector("#worldSummary")?.textContent.trim() ?? "" : "";
}

// Opens a part of the journey. start: how a case part opens ("first",
// "last" coming back from the next part, or "resume").
async function enterPart(index, start = "first") {
  const { JOURNEY, SUGGESTED_QUESTION } = demo.journey;
  demo.store.setPart(index);
  demo.start = start;
  const part = JOURNEY[index];
  if (part.kind !== "speck") {
    renderCoach();
    // Opening the Evidence tab mounts it afresh, and the new mount opens the part.
    if (!host.evidenceOpen()) { host.evidenceButton()?.click(); return; }
    demo.tab?.openPart(index);
    return;
  }
  host.openWorld(part.view);
  if (part.id === "chat") {
    demo.facts.replied = false;
    const input = document.querySelector("#quickPrompt");
    if (input && !input.value.trim()) {
      input.value = SUGGESTED_QUESTION;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
  renderCoach();
  await gatherFacts();
  // The world view settles its own summary after switching mode.
  window.setTimeout(async () => { await gatherFacts(); renderCoach(); }, 800);
  renderCoach();
}

function endJourney() {
  demo.store?.setPart(null);
  hostSpotlight(null);
  renderCoach();
  demo.tab?.renderOffer();
}

function startJourney() {
  demo.store.dismissOffer();
  demo.collapsed = false;
  enterPart(0, "first");
}

function paragraphs(items) {
  return items.filter((item) => item !== null && item !== undefined).map((item) => Array.isArray(item)
    ? el("ul", {}, item.flat().map((line) => el("li", {}, line)))
    : el("p", {}, item));
}

// The panel for the parts outside a case page. Case parts use the case
// page's own panel.
function renderCoach() {
  const part = currentPart();
  if (!part || part.kind === "case") {
    demo.coach?.remove();
    demo.coach = null;
    if (!part) hostSpotlight(null);
    return;
  }
  const { JOURNEY, partDone } = demo.journey;
  const index = JOURNEY.indexOf(part);
  const done = partDone(part, demo.facts);
  const waiting = part.action && !done;
  if (!demo.coach) {
    demo.coach = el("div", { className: "edk edk-journey" }, el("aside", { className: "coach", "aria-labelledby": "edk-journey-title" }));
    demo.coach.addEventListener("click", onCoachClick);
    document.body.append(demo.coach);
  }
  const panel = demo.coach.firstElementChild;
  panel.classList.toggle("collapsed", demo.collapsed);
  const last = index === JOURNEY.length - 1;
  panel.replaceChildren(...el("div", {},
    el("div", { className: "coach-head" },
      el("p", { className: "eyebrow" }, `Guided demo · ${part.label}`),
      el("button", { type: "button", className: "link", "data-journey": "collapse", "aria-expanded": String(!demo.collapsed) }, demo.collapsed ? "Expand" : "Minimise")),
    el("h2", { id: "edk-journey-title", tabindex: "-1" }, part.title),
    demo.collapsed ? null : el("div", { className: "coach-body" }, paragraphs(done && part.after ? part.after(demo.facts) : part.body(demo.facts))),
    part.action && !demo.collapsed ? el("p", { className: `coach-status ${done ? "done" : "waiting"}`, role: "status" },
      done ? "Done." : part.action === "chat" ? "Waiting for you: send a message to Speck."
        : "Waiting for you: click Run investigation.") : null,
    demo.collapsed ? null : el("div", { className: "coach-actions" },
      el("button", { type: "button", className: "secondary", "data-journey": "back" }, "Back"),
      waiting ? el("button", { type: "button", className: "link", "data-journey": "skip" }, "Skip this step") : null,
      el("button", { type: "button", className: "primary", "data-journey": "next", disabled: waiting ? "" : null }, last ? "Finish" : "Next"),
      el("button", { type: "button", className: "link", "data-journey": "exit" }, "Exit the demo"))).childNodes);
  hostSpotlight(part.id === "world" ? document.querySelector("#timelineStatus")
    : part.id === "memory" ? document.querySelector(".world-mode-switch")
    : part.id === "chat" ? document.querySelector("#quickComposer")
    : part.id === "create" ? document.querySelector("form.new-case")
    : null);
  fitCoach();
}

function onCoachClick(event) {
  const action = event.target.closest("[data-journey]")?.dataset.journey;
  if (!action) return;
  const index = demo.store.part();
  const { JOURNEY } = demo.journey;
  if (action === "collapse") { demo.collapsed = !demo.collapsed; renderCoach(); return; }
  if (action === "exit") { endJourney(); return; }
  if (action === "back") enterPart(index - 1, "last");
  if (action === "next" || action === "skip") {
    if (index >= JOURNEY.length - 1) endJourney();
    else enterPart(index + 1, "first");
  }
  demo.coach?.querySelector("#edk-journey-title")?.focus({ preventScroll: true });
}

// Clear of Speck's message bar and rail, which Speck moves between layouts.
// In the world view on a wide screen the panel sits top left, clear of the
// pulse panel and of Speck's replies above the message bar.
function fitCoach() {
  const panel = demo.coach?.firstElementChild;
  if (!panel) return;
  panel.style.top = panel.style.bottom = panel.style.left = panel.style.right = panel.style.width = panel.style.maxHeight = "";
  const bar = document.querySelector("#quickComposer")?.getBoundingClientRect();
  const rail = document.querySelector(".rail")?.getBoundingClientRect();
  const barTop = bar && bar.height && bar.top < innerHeight ? bar.top : innerHeight;
  const verticalRail = rail && rail.height > rail.width && rail.right < innerWidth / 3;
  if (innerWidth < 980) {
    panel.style.left = verticalRail ? `${Math.ceil(rail.right + 8)}px` : "8px";
    panel.style.right = "8px";
    panel.style.width = "auto";
    panel.style.bottom = `${Math.ceil(innerHeight - barTop + 8)}px`;
    panel.style.maxHeight = `${Math.max(160, Math.floor(Math.min(innerHeight * 0.42, barTop - 8 - innerHeight * 0.3)))}px`;
  } else if (host.worldOpen()) {
    panel.style.left = `${Math.ceil((verticalRail ? rail.right : 0) + 16)}px`;
    panel.style.top = "140px";
    panel.style.bottom = "auto";
    panel.style.maxHeight = `${Math.max(200, Math.floor(barTop - 140 - 16))}px`;
  } else {
    panel.style.bottom = `${Math.ceil(innerHeight - barTop + 8)}px`;
    panel.style.maxHeight = `${Math.max(200, Math.floor(Math.min(560, barTop - 16 - innerHeight * 0.1)))}px`;
  }
}

let listening = false;
function listenOnce() {
  if (listening) return;
  listening = true;
  window.addEventListener("resize", fitCoach);
  // Speck announces every chat reply.
  window.addEventListener("speck:reply", () => {
    if (currentPart()?.id !== "chat") return;
    demo.facts.replied = true;
    renderCoach();
  });
  // Speck's views change without telling plugins; keep the panel placed.
  document.addEventListener("click", (event) => {
    if (event.target.closest?.(".rail-button, [data-world-mode]")) window.setTimeout(fitCoach, 50);
  });
}

// ----- The tab -----

function stalePluginNotice(error) {
  return el("section", { className: "edk edk-in-speck" }, el("div", { className: "panel", role: "alert" },
    el("h2", {}, "Evidence Desk was updated after Speck started"),
    el("p", {}, "Speck loads plugins only when it starts, so this Speck is still running the previous version of Evidence Desk while its page files are new. They do not fit together."),
    el("p", {}, el("strong", {}, "Restart Speck: "), "in the terminal where it runs, press Ctrl+C, then start it again the way you did before (for example npm run speck). Then reload this page. Cases and their history are kept in Speck's database."),
    el("p", { className: "meta" }, `Detail: ${error?.message ?? error}`)));
}

export async function mountPluginTab({ root, pluginAdminFetch }) {
  ensureStylesheet();
  const fetcher = pluginAdminFetch || fetch;
  let modules;
  try {
    modules = await Promise.all([import(`${ASSET_BASE}/app.js`), import(`${ASSET_BASE}/journey.js`), import(`${ASSET_BASE}/compare.js`)]);
  } catch (error) {
    // Speck loads a plugin's code once, at startup, but this page's files are
    // read from disk on each request. After npm run plugin:install, a Speck
    // started earlier serves the new page without the files the new page
    // needs. Say so, instead of failing without a reason.
    root.replaceChildren(stalePluginNotice(error));
    return { destroy() {} };
  }
  const [{ mountEvidenceDesk }, journey, { renderEvaluation }] = modules;
  demo.journey = journey;
  demo.store ??= journey.journeyStore(storage());
  demo.fetcher = fetcher;
  listenOnce();

  const shell = el("div", { className: "edk edk-in-speck" });
  const offer = el("section", { className: "intro demo-offer", "aria-labelledby": "edk-demo-offer-title", hidden: "" });
  const picker = el("div", { className: "case-picker", role: "tablist", "aria-label": "Investigations" });
  const page = el("div", { className: "edk-in-speck" });
  // Says what happened after an investigation is deleted, until the next case is opened.
  const notice = el("p", { className: "meta case-notice", role: "status", hidden: "" });
  shell.append(offer, picker, notice, page);
  root.replaceChildren(shell);

  let cases = [];
  let mounted = null;
  let current = null;

  async function loadCases() {
    const response = await fetcher(`${API_BASE}/cases`);
    cases = (await response.json().catch(() => ({}))).cases ?? [];
    renderPicker();
  }

  function renderPicker() {
    const button = (item) => el("button", {
      type: "button", role: "tab", "data-case": item.id, "aria-selected": String(current === item.id),
      className: current === item.id ? "primary" : "secondary"
    }, item.label);
    const prepared = cases.filter((item) => item.kind !== "yours");
    const yours = cases.filter((item) => item.kind === "yours");
    picker.replaceChildren(...el("div", {},
      el("span", { className: "picker-label" }, "Prepared cases"), prepared.map(button),
      yours.length ? [el("span", { className: "picker-label" }, "Your investigations"), yours.map(button)] : null,
      el("button", { type: "button", "data-new-case": "", className: current === "new" ? "primary" : "secondary", "aria-selected": String(current === "new") }, "+ New investigation"),
      el("button", { type: "button", "data-evaluation": "", className: current === "evaluation" ? "primary" : "secondary", "aria-selected": String(current === "evaluation") }, "Evaluation results"),
      el("button", { type: "button", "data-demo": "start", className: "link" }, demo.store.part() !== null ? "Resume the guided demo" : "Guided demo")).childNodes);
  }

  // The invitation to the guided demo, until it is taken or declined.
  function renderOffer() {
    renderPicker();
    offer.hidden = demo.store.part() !== null || demo.store.offerDismissed();
    if (offer.hidden) return;
    offer.replaceChildren(
      el("h2", { id: "edk-demo-offer-title" }, "Take the guided demo"),
      el("p", {}, "Two investigations where the evidence changes: a disputed delivery and a bank return. Then Speck's own views of the same work: its world timeline, its memory map of how the facts are linked, and its chat. Then an investigation of your own."),
      el("p", { className: "meta" }, "Each step that asks you to act waits for the real result; nothing is scripted."),
      el("div", { className: "intro-actions" },
        el("button", { type: "button", className: "primary", "data-demo": "start" }, "Start the guided demo"),
        el("button", { type: "button", className: "secondary", "data-demo": "dismiss" }, "Explore on my own")));
  }

  function show(id, { guided = null } = {}) {
    const item = cases.find((candidate) => candidate.id === id) ?? cases[0];
    if (!item) { page.textContent = "Evidence Desk could not list its cases."; return; }
    mounted?.destroy();
    notice.hidden = true;
    current = item.id;
    remember("case", item.id);
    renderPicker();
    mounted = mountEvidenceDesk(page, {
      apiBase: `${API_BASE}/cases/${encodeURIComponent(item.id)}`, fetchImpl: fetcher, userCase: item.kind === "yours",
      intro: false, guided, evaluationUrl: `${API_BASE}/evaluation`,
      onDeleted: async (result) => {
        await loadCases();
        show(cases[0]?.id);
        notice.hidden = false;
        notice.textContent = `"${result.label}" was deleted. Its files are kept in ${result.keptIn}.`;
      }
    });
  }

  // Opens a part of the guided demo that happens on this tab.
  function openPart(index) {
    const { JOURNEY } = demo.journey;
    const part = JOURNEY[index];
    if (part.kind === "case") {
      const start = demo.start;
      // A later mount of the tab (after a visit to another view) resumes the part.
      demo.start = "resume";
      show(part.caseId, { guided: {
        label: `Guided demo · ${part.label}`, steps: part.steps, finishLabel: part.finishLabel, start,
        onFinish: () => enterPart(index + 1, "first"),
        onBack: index > 0 ? () => enterPart(index - 1, "last") : null,
        onExit: endJourney
      } });
    } else if (part.id === "create") {
      openNewCase();
    }
    renderOffer();
    renderCoach();
  }

  // A new investigation of the person's own: the question, the competing
  // explanations, and optionally the first evidence.
  function openNewCase() {
    mounted?.destroy();
    mounted = null;
    current = "new";
    renderPicker();
    page.classList.add("edk");
    const explanations = el("div", { className: "explanations-fields" });
    const addExplanation = (value = "") => {
      const index = explanations.children.length + 1;
      explanations.append(el("label", { className: "field" }, `Explanation ${index}`,
        el("input", { type: "text", name: "explanation", maxlength: "300", value, placeholder: index === 1 ? "e.g. The laptop was returned and lost at the warehouse." : "e.g. The laptop was never sent back." })));
    };
    addExplanation(); addExplanation();
    const error = el("p", { className: "dialog-error", role: "alert", hidden: "" });
    const form = el("form", { className: "panel new-case", novalidate: "" },
      el("h2", { id: "edk-new-case-title", tabindex: "-1" }, "Start an investigation of your own"),
      el("p", { className: "muted" }, "Write the question, the explanations that compete to answer it, and any evidence you already have. It is investigated like the prepared cases: each record is weighed against each explanation, corrections replace what they correct, and every change is kept in the history."),
      el("p", { className: "meta" }, "Your evidence is free text, so only a reasoning model can weigh it (the model assessor, with Speck's 0.4 cap on model-judged evidence). It is stored in this plugin's data folder and sent only to the configured model provider."),
      el("label", { className: "field" }, "Title", el("input", { type: "text", name: "title", maxlength: "120", placeholder: "e.g. Missing laptop return" })),
      el("label", { className: "field" }, "The question", el("textarea", { name: "question", rows: "2", maxlength: "600", placeholder: "e.g. The customer says they returned laptop SN-4471; the warehouse has no record of it. Was it returned?" })),
      el("fieldset", {}, el("legend", {}, "Competing explanations (2 to 5)"), explanations,
        el("button", { type: "button", className: "link", "data-add-explanation": "" }, "Add another explanation")),
      el("fieldset", {}, el("legend", {}, "First evidence (optional)"),
        el("label", { className: "field" }, "Source", el("input", { type: "text", name: "source", maxlength: "120", placeholder: "e.g. Courier pickup log" })),
        el("label", { className: "field" }, "What it says", el("textarea", { name: "content", rows: "2", maxlength: "1200", placeholder: "e.g. Pickup of a 2.1 kg parcel from the customer on 3 Oct." })),
        el("label", { className: "field" }, "When the source recorded it (optional)", el("input", { type: "date", name: "observedAt" }))),
      error,
      el("div", { className: "dialog-actions" }, el("button", { type: "submit", className: "primary" }, "Create investigation")));
    form.querySelector("[data-add-explanation]").addEventListener("click", () => {
      if (explanations.children.length < 5) addExplanation();
      if (explanations.children.length >= 5) form.querySelector("[data-add-explanation]").hidden = true;
      explanations.lastElementChild.querySelector("input").focus();
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const value = (name) => form.querySelector(`[name="${name}"]`).value.trim();
      const body = {
        title: value("title"), question: value("question"),
        explanations: [...form.querySelectorAll('[name="explanation"]')].map((input) => input.value.trim()).filter(Boolean),
        evidence: value("content") ? [{ source: value("source") || "Entered by you", content: value("content"), ...(value("observedAt") ? { observedAt: value("observedAt") } : {}) }] : []
      };
      const submit = form.querySelector("[type=submit]");
      submit.disabled = true;
      error.hidden = true;
      try {
        const response = await fetcher(`${API_BASE}/cases`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
        await loadCases();
        show(result.id);
      } catch (failure) {
        error.hidden = false;
        error.textContent = `The investigation was not created: ${failure.message}`;
        submit.disabled = false;
      }
    });
    page.replaceChildren(form);
    form.querySelector("#edk-new-case-title").focus();
  }

  // The evaluation results on their own page: every report the evaluation
  // commands wrote, and the saved side-by-side comparisons.
  async function openEvaluation() {
    mounted?.destroy();
    mounted = null;
    current = "evaluation";
    renderPicker();
    page.classList.add("edk");
    const holder = el("div", {}, el("p", { className: "muted" }, "Loading the evaluation results…"));
    page.replaceChildren(el("section", { className: "panel evaluation-page" }, el("h2", { id: "edk-evaluation-title", tabindex: "-1" }, "Evaluation results"), holder));
    page.querySelector("#edk-evaluation-title").focus();
    try {
      const response = await fetcher(`${API_BASE}/evaluation`);
      const summary = await response.json();
      if (!response.ok) throw new Error(summary.error ?? `HTTP ${response.status}`);
      if (current === "evaluation") renderEvaluation(holder, summary);
    } catch (failure) {
      holder.replaceChildren(el("p", { className: "error" }, `The evaluation results could not be loaded: ${failure.message}`));
    }
  }

  shell.addEventListener("click", (event) => {
    const target = event.target.closest("button");
    if (!target) return;
    if (target.dataset.demo === "start") {
      if (demo.store.part() !== null) enterPart(demo.store.part(), "resume");
      else startJourney();
    } else if (target.dataset.demo === "dismiss") {
      demo.store.dismissOffer();
      renderOffer();
    } else if (target.closest(".case-picker")) {
      if (target.dataset.newCase !== undefined) openNewCase();
      else if (target.dataset.evaluation !== undefined) openEvaluation();
      else if (target.dataset.case) show(target.dataset.case);
    }
  });

  await loadCases();
  const api = {
    destroy: () => mounted?.destroy(),
    show, openNewCase, openPart, renderOffer,
    current: () => current,
    cases: () => cases
  };
  demo.tab = api;

  const part = demo.store.part();
  const firstMount = !demo.mounted;
  demo.mounted = true;
  if (part !== null && demo.journey.JOURNEY[part].kind !== "speck") openPart(part);
  else {
    const remembered = recall("case");
    show(cases.some((item) => item.id === remembered) ? remembered : cases[0]?.id);
    renderOffer();
    // On a page load in the middle of a part in Speck's own views, that view
    // opens again; a later visit to this tab leaves the person here.
    if (part !== null && firstMount) enterPart(part, "resume");
    else renderCoach();
  }
  return api;
}
