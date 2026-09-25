const modeWalmartBtn = document.querySelector("#mode-walmart");
const modeTemuBtn = document.querySelector("#mode-temu");
const titleEl = document.querySelector("#title");
const blurbEl = document.querySelector("#blurb");
const statusEl = document.querySelector("#status");
const countsEl = document.querySelector("#counts");
const detailsEl = document.querySelector("#details");
const ledgerEl = document.querySelector("#ledger");
const ledgerLabelEl = document.querySelector("#ledger-label");
const ledgerHintEl = document.querySelector("#ledger-hint");
const returnsRow = document.querySelector("#returns-row");
const returnsEl = document.querySelector("#returns");
const openBtn = document.querySelector("#open");
const openTemuBtn = document.querySelector("#open-temu");
const collectBtn = document.querySelector("#collect");
const resumeBtn = document.querySelector("#resume");
const restartBtn = document.querySelector("#restart");
const stopBtn = document.querySelector("#stop");
const jsonBtn = document.querySelector("#json");
const csvBtn = document.querySelector("#csv");
const archiveBtn = document.querySelector("#archive");
const clearBtn = document.querySelector("#clear");

const RUNNING = new Set(["history", "details", "ledger"]);
const WALMART_ORDERS = "https://www.walmart.com/orders";
const TEMU_ORDERS = "https://www.temu.com/bgt_orders.html";
let clearArmed = false;
let optionsSyncedFor = "";
let mode = "walmart";
let modeReady = false;
let picked = false;

function send(message) {
  return chrome.runtime.sendMessage({ channel: "wmh", from: "popup", ...message });
}

function onOrdersPage(url, store) {
  return store === "temu" ? TMHProtocol.isOrdersListUrl(url) : WMHProtocol.isOrdersListUrl(url);
}

async function ordersTab(store) {
  const tabs = await chrome.tabs.query({});
  return tabs.find((tab) => onOrdersPage(tab.url || "", store)) || null;
}

function showMode() {
  const temu = mode === "temu";
  modeWalmartBtn.setAttribute("aria-pressed", temu ? "false" : "true");
  modeTemuBtn.setAttribute("aria-pressed", temu ? "true" : "false");
  titleEl.textContent = temu ? "Temu Order History" : "Walmart Order History";
  blurbEl.textContent = temu
    ? "Builds a local archive of the signed-in account from temu.com/bgt_orders.html. Nothing is uploaded."
    : "Builds a local archive of the signed-in account from walmart.com/orders. Nothing is uploaded.";
  ledgerLabelEl.textContent = temu ? "Payment details" : "Payment ledger";
  ledgerHintEl.textContent = temu ? "(charges on each order)" : "(slower, actual charges)";
  returnsRow.hidden = !temu;
  collectBtn.textContent = temu ? "Collect Temu history" : "Collect Walmart history";
  openBtn.hidden = temu;
  openTemuBtn.hidden = !temu;
  statusEl.classList.remove("error");
  statusEl.textContent = temu
    ? "Temu mode. Open the Temu orders page while signed in, then collect."
    : "Walmart mode. Open the Walmart orders page while signed in, then collect.";
}

function render(meta, url, ordersUrl) {
  const store = mode;
  const ready = onOrdersPage(ordersUrl || "", store) || onOrdersPage(url || "", store);
  showMode();
  const running = RUNNING.has(meta.phase);
  const hasArchive = (meta.orderCount || 0) > 0 || (meta.pages || 0) > 0;
  const temu = store === "temu";
  titleEl.textContent = temu ? "Temu Order History" : "Walmart Order History";
  blurbEl.textContent = temu
    ? "Builds a local archive of the signed-in account from temu.com/bgt_orders.html. Nothing is uploaded."
    : "Builds a local archive of the signed-in account from walmart.com/orders. Nothing is uploaded.";
  ledgerLabelEl.textContent = temu ? "Payment details" : "Payment ledger";
  ledgerHintEl.textContent = temu ? "(charges on each order)" : "(slower, actual charges)";
  statusEl.classList.toggle("error", meta.phase === "error");
  statusEl.textContent = ready
    ? (meta.message || "Ready to collect this account.")
    : temu
      ? "Open your Temu orders page while signed in. Collection reads only that account."
      : "Open your Walmart orders page while signed in. Collection reads only that account.";
  if (meta.lastError && meta.phase === "error") statusEl.textContent = meta.lastError;
  const paymentLabel = temu ? "with payment" : "with ledger";
  countsEl.textContent = hasArchive
    ? `${meta.orderCount || 0} orders · ${meta.detailCount || 0} with details · ${meta.ledgerCount || 0} ${paymentLabel} · ${meta.pages || 0} history pages`
    : "No archive saved in this browser yet.";
  if (optionsSyncedFor !== store) {
    detailsEl.checked = meta.options?.details !== false;
    ledgerEl.checked = meta.options?.ledger !== false;
    returnsEl.checked = meta.options?.returns !== false;
    optionsSyncedFor = store;
  }
  detailsEl.disabled = running;
  ledgerEl.disabled = running;
  returnsEl.disabled = running;
  openBtn.hidden = ready || temu;
  openTemuBtn.hidden = ready || !temu;
  collectBtn.hidden = !ready || running || hasArchive;
  resumeBtn.hidden = !ready || running || !hasArchive;
  restartBtn.hidden = !ready || running || !hasArchive;
  stopBtn.hidden = !running;
  jsonBtn.disabled = !hasArchive || running;
  csvBtn.disabled = !hasArchive || running;
  clearBtn.disabled = !hasArchive || running;
  clearBtn.textContent = clearArmed ? "Confirm clear" : "Clear archive";
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function refresh() {
  if (!modeReady) return;
  const tab = await activeTab();
  const orders = await ordersTab(mode);
  const response = await send({ type: "get-state", store: mode });
  const fallback = mode === "temu" ? TMHProtocol.emptyMeta() : WMHProtocol.emptyMeta();
  render(response?.meta || fallback, tab?.url || "", orders?.url || "");
}

async function stopWalmartIfRunning() {
  const walmart = await send({ type: "get-state", store: "walmart" });
  if (["history", "details", "ledger"].includes(walmart?.meta?.phase)) {
    await send({ type: "stop", store: "walmart" });
  }
}

async function chooseMode(next) {
  picked = true;
  if (next !== mode) optionsSyncedFor = "";
  mode = next;
  clearArmed = false;
  showMode();
  try {
    await chrome.storage.local.set({ orderStore: mode });
  } catch {
    /* the panel still switches if storage is unavailable */
  }
  try {
    if (next === "temu") await stopWalmartIfRunning();
    const orders = await ordersTab(next);
    if (orders?.id) await chrome.tabs.update(orders.id, { active: true });
  } catch {
    /* focusing the orders tab is optional */
  }
  try {
    await refresh();
  } catch (error) {
    statusEl.classList.add("error");
    statusEl.textContent = error?.message || "Could not switch stores.";
  }
}

async function start(fresh) {
  clearArmed = false;
  const orders = await ordersTab(mode);
  const response = await send({
    type: "start",
    store: mode,
    tabId: orders?.id || null,
    fresh,
    details: detailsEl.checked,
    ledger: ledgerEl.checked,
    returns: returnsEl.checked,
  });
  if (!response?.ok) {
    statusEl.classList.add("error");
    statusEl.textContent = response?.error || "Could not start.";
    return;
  }
  await refresh();
}

async function openOrders(url, host) {
  const tab = await activeTab();
  if (tab?.id && tab.url?.includes(host)) await chrome.tabs.update(tab.id, { url });
  else await chrome.tabs.create({ url });
  window.close();
}

modeWalmartBtn.addEventListener("click", () => chooseMode("walmart"));
modeTemuBtn.addEventListener("click", () => chooseMode("temu"));
openBtn.addEventListener("click", () => openOrders(WALMART_ORDERS, "walmart.com"));
openTemuBtn.addEventListener("click", () => openOrders(TEMU_ORDERS, "temu.com"));
collectBtn.addEventListener("click", () => start(true));
resumeBtn.addEventListener("click", () => start(false));
restartBtn.addEventListener("click", () => start(true));
stopBtn.addEventListener("click", async () => {
  await send({ type: "stop", store: mode });
  await refresh();
});

jsonBtn.addEventListener("click", () => WMHDownload.downloadArchive("json", mode));
csvBtn.addEventListener("click", () => WMHDownload.downloadArchive("csv", mode));
archiveBtn.addEventListener("click", () => {
  const url = mode === "temu"
    ? chrome.runtime.getURL("src/viewer.html?store=temu")
    : chrome.runtime.getURL("src/viewer.html");
  chrome.tabs.create({ url });
});

clearBtn.addEventListener("click", async () => {
  if (!clearArmed) {
    clearArmed = true;
    clearBtn.textContent = "Confirm clear";
    return;
  }
  clearArmed = false;
  const response = await send({ type: "clear", store: mode });
  if (!response?.ok) {
    statusEl.classList.add("error");
    statusEl.textContent = response?.error || "Could not clear the archive.";
    return;
  }
  await refresh();
});

async function initMode() {
  modeReady = true;
  try {
    const tab = await activeTab();
    if (picked) {
      showMode();
      await refresh();
      return;
    }
    const url = tab?.url || "";
    if (url.includes("temu.com")) mode = "temu";
    else if (WMHProtocol.isOrdersListUrl(url)) mode = "walmart";
    else {
      try {
        const saved = await chrome.storage.local.get("orderStore");
        if (!picked && (saved.orderStore === "temu" || saved.orderStore === "walmart")) mode = saved.orderStore;
      } catch {
        /* keep the default until the toggle is clicked */
      }
    }
  } catch {
    /* keep the default until the toggle is clicked */
  }
  if (!picked) showMode();
  try {
    if (mode === "temu") await stopWalmartIfRunning();
    await refresh();
  } catch (error) {
    showMode();
    statusEl.classList.add("error");
    statusEl.textContent = error?.message || "Could not read this tab.";
  }
}

initMode();
setInterval(refresh, 800);
