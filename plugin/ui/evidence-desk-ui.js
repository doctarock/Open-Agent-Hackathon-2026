// The Evidence tab in Speck's interface. Speck mounts it; it shows the same
// page as the standalone Evidence Desk (public/app.js), styled with Speck's
// palette, for whichever case is selected, and the form for starting an
// investigation of the person's own. Requests go through Speck's
// admin-authorised fetch, as Speck requires for plugin routes.

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

export async function mountPluginTab({ root, pluginAdminFetch }) {
  ensureStylesheet();
  const fetcher = pluginAdminFetch || fetch;
  const { mountEvidenceDesk } = await import(`${ASSET_BASE}/app.js`);

  const shell = el("div", { className: "edk edk-in-speck" });
  const picker = el("div", { className: "case-picker", role: "tablist", "aria-label": "Investigations" });
  const page = el("div", { className: "edk-in-speck" });
  shell.append(picker, page);
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
      el("button", { type: "button", "data-new-case": "", className: current === "new" ? "primary" : "secondary", "aria-selected": String(current === "new") }, "+ New investigation")).childNodes);
  }

  function show(id) {
    const item = cases.find((candidate) => candidate.id === id) ?? cases[0];
    if (!item) { page.textContent = "Evidence Desk could not list its cases."; return; }
    mounted?.destroy();
    current = item.id;
    remember("case", item.id);
    renderPicker();
    mounted = mountEvidenceDesk(page, { apiBase: `${API_BASE}/cases/${encodeURIComponent(item.id)}`, fetchImpl: fetcher, userCase: item.kind === "yours" });
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
      el("p", { className: "meta" }, "Your evidence is free text, so only a reasoning model can weigh it (the local Nemotron assessor, with Speck's 0.4 cap on model-judged evidence). It is stored in this plugin's data folder, not sent anywhere."),
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
        api.onCreated?.(result);
      } catch (failure) {
        error.hidden = false;
        error.textContent = `The investigation was not created: ${failure.message}`;
        submit.disabled = false;
      }
    });
    page.replaceChildren(form);
    form.querySelector("#edk-new-case-title").focus();
  }

  picker.addEventListener("click", (event) => {
    const target = event.target.closest("button");
    if (!target) return;
    if (target.dataset.newCase !== undefined) openNewCase();
    else if (target.dataset.case) show(target.dataset.case);
  });

  await loadCases();
  const remembered = recall("case");
  show(cases.some((item) => item.id === remembered) ? remembered : cases[0]?.id);

  const api = {
    destroy: () => mounted?.destroy(),
    show, openNewCase,
    current: () => current,
    cases: () => cases,
    onCreated: null
  };
  return api;
}
