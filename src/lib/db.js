/* Extension-origin archive. Orders never leave this browser profile. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.WMHDB = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const DB_NAME = "wmh";
  const DB_VERSION = 1;
  let opening = null;

  function openDb() {
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("orders")) db.createObjectStore("orders", { keyPath: "orderId" });
        if (!db.objectStoreNames.contains("pages")) db.createObjectStore("pages", { keyPath: "cursorKey" });
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        opening = null;
        reject(request.error || new Error("Could not open the local archive"));
      };
    });
    return opening;
  }

  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
    });
  }

  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed"));
      tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
    });
  }

  async function getMeta() {
    const db = await openDb();
    const tx = db.transaction("meta", "readonly");
    const stored = await requestToPromise(tx.objectStore("meta").get("run"));
    await txDone(tx);
    return stored || globalThis.WMHProtocol.emptyMeta();
  }

  async function setMeta(patch) {
    const db = await openDb();
    const current = await getMeta();
    const force = !!patch.force;
    const rest = { ...patch };
    delete rest.force;
    const next = { ...current, ...rest, id: "run", updatedAt: new Date().toISOString() };
    if (current.phase === "stopped" && !force && rest.phase && rest.phase !== "stopped") next.phase = "stopped";
    const tx = db.transaction("meta", "readwrite");
    tx.objectStore("meta").put(next);
    await txDone(tx);
    return next;
  }

  async function getOrder(orderId) {
    const db = await openDb();
    const tx = db.transaction("orders", "readonly");
    const stored = await requestToPromise(tx.objectStore("orders").get(orderId));
    await txDone(tx);
    return stored || null;
  }

  async function putMerged(orderId, patch) {
    const db = await openDb();
    const existing = await getOrder(orderId);
    let seq = existing?.seq;
    if (seq == null) {
      const meta = await getMeta();
      seq = meta.nextSeq || 1;
      await setMeta({ nextSeq: seq + 1 });
    }
    const merged = globalThis.WMHProtocol.mergeOrder(existing, { ...patch, orderId, seq });
    const tx = db.transaction("orders", "readwrite");
    tx.objectStore("orders").put(merged);
    await txDone(tx);
    return merged;
  }

  async function saveHistoryPage(payload) {
    const db = await openDb();
    const tx = db.transaction("pages", "readwrite");
    tx.objectStore("pages").put({
      cursorKey: payload.cursorKey,
      nextCursor: payload.nextCursor || "",
      response: payload.response,
      savedAt: new Date().toISOString(),
    });
    await txDone(tx);
    for (const item of payload.tagged || []) {
      await putMerged(item.orderId, {
        summaries: [item.group],
        groupIds: [item.groupId],
        inStore: item.inStore,
      });
    }
    const orders = await listOrders();
    return setMeta({
      phase: "history",
      cursor: payload.nextCursor || "",
      pages: (await listPages()).length,
      orderCount: orders.length,
      message: `Saved ${orders.length} orders`,
      lastError: "",
    });
  }

  async function listOrders() {
    const db = await openDb();
    const tx = db.transaction("orders", "readonly");
    const rows = await requestToPromise(tx.objectStore("orders").getAll());
    await txDone(tx);
    return (rows || []).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  }

  async function listPages() {
    const db = await openDb();
    const tx = db.transaction("pages", "readonly");
    const rows = await requestToPromise(tx.objectStore("pages").getAll());
    await txDone(tx);
    return rows || [];
  }

  async function clearAll() {
    const db = await openDb();
    const tx = db.transaction(["orders", "pages", "meta"], "readwrite");
    tx.objectStore("orders").clear();
    tx.objectStore("pages").clear();
    tx.objectStore("meta").clear();
    await txDone(tx);
    opening = null;
    return setMeta({ ...globalThis.WMHProtocol.emptyMeta(), force: true });
  }

  async function buildJob(options) {
    const fresh = !!options.fresh;
    if (fresh) await clearAll();
    const meta = await getMeta();
    const orders = fresh ? [] : await listOrders();
    const detailQueue = [];
    const ledgerQueue = [];
    const haveDetailIds = [];
    const haveLedgerIds = [];
    for (const order of orders) {
      if (!order.orderId || String(order.orderId).startsWith("unknown-")) continue;
      if (order.detailResponse) haveDetailIds.push(order.orderId);
      else if (options.details) {
        detailQueue.push({
          orderId: order.orderId,
          groupId: order.groupIds?.[0] || "0",
          inStore: !!order.inStore,
        });
      }
      if (order.ledgerResponse) haveLedgerIds.push(order.orderId);
      else if (options.ledger) ledgerQueue.push({ orderId: order.orderId });
    }
    await setMeta({
      phase: meta.historyDone && !fresh ? "details" : "history",
      lastError: "",
      message: fresh ? "Starting from the first page" : "Continuing the saved archive",
      options: { details: !!options.details, ledger: !!options.ledger },
      force: true,
    });
    return {
      cursor: fresh || meta.historyDone ? "" : meta.cursor || "",
      historyDone: fresh ? false : !!meta.historyDone,
      options: { details: !!options.details, ledger: !!options.ledger },
      detailQueue,
      ledgerQueue,
      haveDetailIds,
      haveLedgerIds,
      historyTemplate: null,
      orderTemplate: null,
      ledgerTemplate: null,
      limit: globalThis.WMHProtocol.HISTORY_LIMIT,
      safetyPages: globalThis.WMHProtocol.SAFETY_PAGES_PER_RUN,
    };
  }

  return {
    openDb,
    getMeta,
    setMeta,
    getOrder,
    putMerged,
    saveHistoryPage,
    listOrders,
    listPages,
    clearAll,
    buildJob,
  };
});
