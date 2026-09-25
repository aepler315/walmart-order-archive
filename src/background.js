/* Stores each store's archive in the extension's IndexedDB and tracks progress. */
importScripts("lib/protocol.js", "lib/db.js", "lib/temu.js", "lib/temu-db.js");

const active = { walmart: null, temu: null };

function badgeText(count) {
  if (!count) return "";
  if (count > 9999) return "9k+";
  return String(count);
}

async function setBadge(count, tabId, store) {
  const text = badgeText(count);
  try {
    await chrome.action.setBadgeText({ text, tabId });
    await chrome.action.setBadgeBackgroundColor({ color: store === "temu" ? "#fb7701" : "#1a4b8c", tabId });
  } catch {
    /* badge updates are optional */
  }
}

function dbFor(store) {
  return store === "temu" ? TMHDB : WMHDB;
}

function storeFromUrl(url) {
  if (TMHProtocol.isOrdersListUrl(url || "")) return "temu";
  if (WMHProtocol.isOrdersListUrl(url || "")) return "walmart";
  return "";
}

async function ordersTabs(store) {
  const tabs = await chrome.tabs.query({});
  return tabs.filter((tab) => tab.id && storeFromUrl(tab.url || "") === store);
}

async function stopStore(store) {
  const ids = new Set((await ordersTabs(store)).map((tab) => tab.id));
  if (active[store]) ids.add(active[store]);
  for (const tabId of ids) {
    try {
      await chrome.tabs.sendMessage(tabId, { channel: "wmh", from: "background", payload: { type: "stop", store } });
    } catch {
      /* the orders tab may already be closed */
    }
  }
  await dbFor(store).setMeta({ phase: "stopped", message: "Stopped. Saved orders are kept.", force: true });
}

async function ensureHooks(tabId, store) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { channel: "wmh", from: "background", payload: { type: "ping" } });
    if (response?.ok) return;
  } catch {
    /* the orders tab was open before the extension loaded */
  }
  const files = store === "temu"
    ? ["src/lib/temu.js", "src/temu-hook.js"]
    : ["src/lib/protocol.js", "src/page-hook.js"];
  await chrome.scripting.executeScript({
    target: { tabId },
    files,
    world: "MAIN",
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["src/bridge.js"],
    world: "ISOLATED",
  });
}

async function handlePage(payload) {
  const store = payload.store === "temu" ? "temu" : "walmart";
  const db = dbFor(store);
  const tabId = active[store];
  if (payload.type === "history-page") {
    const meta = await db.saveHistoryPage(payload);
    if (tabId) await setBadge(meta.orderCount, tabId, store);
    return { ok: true };
  }
  if (payload.type === "history-done") {
    await db.setMeta({ historyDone: true, phase: "details", cursor: "", message: "Order list complete. Fetching details." });
    return { ok: true };
  }
  if (payload.type === "detail") {
    const patch = {
      detailResponse: payload.response,
      detailError: payload.error || "",
    };
    if (store !== "temu") {
      patch.groupIds = payload.groupId ? [String(payload.groupId)] : [];
      patch.inStore = payload.inStore;
    }
    await db.putMerged(payload.orderId, patch);
    const orders = await db.listOrders();
    const detailCount = orders.filter((order) => order.detailResponse).length;
    await db.setMeta({
      phase: "details",
      detailCount,
      orderCount: orders.length,
      message: payload.error ? `Detail skipped for ${payload.orderId}` : `Saved detail for ${payload.orderId}`,
    });
    return { ok: true };
  }
  if (payload.type === "ledger") {
    await db.putMerged(payload.orderId, {
      ledgerResponse: payload.response,
      ledgerError: payload.error || "",
    });
    const orders = await db.listOrders();
    const ledgerCount = orders.filter((order) => order.ledgerResponse).length;
    await db.setMeta({
      phase: "ledger",
      ledgerCount,
      message: store === "temu" ? `Saved payment ${ledgerCount}` : `Saved ledger ${ledgerCount}`,
    });
    return { ok: true };
  }
  if (payload.type === "progress") {
    await db.setMeta({ phase: payload.phase || "history", message: payload.message || "" });
    return { ok: true };
  }
  if (payload.type === "paused") {
    await db.setMeta({ phase: "paused", cursor: payload.cursor || "", message: payload.message || "Paused." });
    return { ok: true };
  }
  if (payload.type === "stopped") {
    await db.setMeta({ phase: "stopped", cursor: payload.cursor || "", message: payload.message || "Stopped. Saved orders are kept." });
    return { ok: true };
  }
  if (payload.type === "done") {
    const orders = await db.listOrders();
    await db.setMeta({
      phase: "done",
      historyDone: true,
      orderCount: orders.length,
      detailCount: orders.filter((order) => order.detailResponse).length,
      ledgerCount: orders.filter((order) => order.ledgerResponse).length,
      message: payload.message || "Full history saved in this browser.",
      lastError: "",
    });
    if (tabId) await setBadge(orders.length, tabId, store);
    return { ok: true };
  }
  if (payload.type === "error") {
    await db.setMeta({ phase: "error", lastError: payload.message || "Collection failed", message: payload.message || "Collection failed" });
    return { ok: true };
  }
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.channel !== "wmh") return;
  const run = async () => {
    if (message.from === "page") {
      const store = message.payload?.store === "temu" ? "temu" : "walmart";
      if (sender.tab?.id) active[store] = sender.tab.id;
      return handlePage(message.payload || {});
    }
    const store = message.store === "temu" ? "temu" : "walmart";
    const db = dbFor(store);
    if (message.type === "get-state") {
      return { ok: true, store, meta: await db.getMeta() };
    }
    if (message.type === "clear") {
      const meta = await db.getMeta();
      if (meta.phase === "history" || meta.phase === "details" || meta.phase === "ledger") {
        return { ok: false, error: "Stop collection before clearing the archive." };
      }
      await db.clearAll();
      if (active[store]) await setBadge(0, active[store], store);
      return { ok: true, meta: await db.getMeta() };
    }
    if (message.type === "stop") {
      await stopStore(store);
      return { ok: true, meta: await db.getMeta() };
    }
    if (message.type === "start") {
      if (store !== "temu" && store !== "walmart") {
        return { ok: false, error: "Choose Walmart or Temu first." };
      }
      const candidates = await ordersTabs(store);
      const hinted = candidates.find((tab) => tab.id === message.tabId);
      const tab = hinted || candidates[0];
      if (!tab?.id) {
        const address = store === "temu" ? "https://www.temu.com/bgt_orders.html" : "https://www.walmart.com/orders";
        return { ok: false, error: `Open ${address} while you are signed in, then collect.` };
      }
      const current = await db.getMeta();
      if (["history", "details", "ledger"].includes(current.phase)) {
        return { ok: false, error: "Collection is already running for this store." };
      }
      const other = store === "temu" ? "walmart" : "temu";
      const otherMeta = await dbFor(other).getMeta();
      if (["history", "details", "ledger"].includes(otherMeta.phase)) await stopStore(other);
      active[store] = tab.id;
      await ensureHooks(tab.id, store);
      const job = await db.buildJob({
        fresh: !!message.fresh,
        details: !!message.details,
        ledger: !!message.ledger,
        returns: message.returns !== false,
      });
      try {
        await chrome.tabs.sendMessage(tab.id, { channel: "wmh", from: "background", payload: { type: "start", store, job } });
      } catch (error) {
        await db.setMeta({ phase: "error", lastError: error?.message || String(error), message: "Reload the orders page, then collect again." });
        return { ok: false, error: "Reload the orders page, then collect again." };
      }
      return { ok: true, meta: await db.getMeta() };
    }
    return { ok: false, error: "Unknown message" };
  };
  run().then(sendResponse, (error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});
