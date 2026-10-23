// The Evidence tab in Speck's interface. Speck mounts it; it shows the same
// page as the standalone Evidence Desk (public/app.js), styled with Speck's
// palette, for whichever case is selected. Requests go through Speck's
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

export async function mountPluginTab({ root, pluginAdminFetch }) {
  ensureStylesheet();
  const fetcher = pluginAdminFetch || fetch;
  const { mountEvidenceDesk } = await import(`${ASSET_BASE}/app.js`);
  const response = await fetcher(`${API_BASE}/cases`);
  const { cases = [] } = await response.json().catch(() => ({}));

  const shell = document.createElement("div");
  shell.className = "edk edk-in-speck";
  const picker = document.createElement("div");
  picker.className = "case-picker";
  picker.setAttribute("aria-label", "Cases");
  picker.setAttribute("role", "tablist");
  const page = document.createElement("div");
  page.className = "edk-in-speck";
  shell.append(picker, page);
  root.replaceChildren(shell);

  let mounted = null;
  const show = (id) => {
    mounted?.destroy();
    for (const button of picker.querySelectorAll("button")) {
      const selected = button.dataset.case === id;
      button.setAttribute("aria-selected", String(selected));
      button.className = selected ? "primary" : "secondary";
    }
    mounted = mountEvidenceDesk(page, { apiBase: `${API_BASE}/cases/${encodeURIComponent(id)}`, fetchImpl: fetcher });
  };
  for (const item of cases) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.case = item.id;
    button.setAttribute("role", "tab");
    button.textContent = item.label;
    button.addEventListener("click", () => show(item.id));
    picker.append(button);
  }
  if (cases.length) show(cases[0].id);
  else page.textContent = "Evidence Desk could not list its cases.";
  return { destroy: () => mounted?.destroy() };
}
