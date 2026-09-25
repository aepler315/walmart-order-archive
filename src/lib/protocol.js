/* Walmart order-history helpers. No network, no cookies. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.WMHProtocol = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const DELAY_MS = { history: 800, detail: 500, ledger: 1200 };
  const SAFETY_PAGES_PER_RUN = 500;
  const HISTORY_LIMIT = 20;

  const DEFAULTS = {
    PurchaseHistoryV2: {
      prefix: "/orchestra/cph/graphql/PurchaseHistoryV2/",
      hashes: ["2c3d5a832b56671dca1ed0ec84940f274d0bc80821db4ad7481e496c0ad5847e"],
    },
    getOrder: {
      prefix: "/orchestra/orders/graphql/getOrder/",
      hashes: [
        "0d0e73dcfbe4c7a4cb6c8ce929e5b9a8b3e731e4bac81969eed76dbdab28b0d2",
        "d0622497daef19150438d07c506739d451cad6749cf45c3b4db95f2f5a0a65c4",
      ],
    },
    getOrderLedger: {
      prefix: "/orchestra/orders/graphql/getOrderLedger/",
      hashes: ["1234d48bfc5e62b608c0dae2c5752f31978870456bcf0023bad3988009e70919"],
    },
  };

  const PLATFORM_VERSION_RE = /usweb-\d+\.\d+\.\d+-[A-Za-z0-9._-]{8,180}/;
  const OP_URL_RE = /\/orchestra\/(.+?)\/graphql\/(PurchaseHistoryV2|getOrderLedger|getOrder)\/([a-f0-9]{64})\/?$/i;

  function isOrdersListUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.hostname === "www.walmart.com" && /^\/orders\/?$/.test(parsed.pathname);
    } catch {
      return false;
    }
  }

  function parseOperationUrl(raw) {
    let parsed;
    try {
      parsed = new URL(String(raw), "https://www.walmart.com");
    } catch {
      return null;
    }
    const match = parsed.pathname.match(OP_URL_RE);
    if (!match) return null;
    let variables = null;
    const encoded = parsed.searchParams.get("variables");
    if (encoded) {
      try {
        variables = JSON.parse(encoded);
      } catch {
        variables = null;
      }
    }
    const operation = match[2];
    return {
      operation,
      method: "GET",
      hash: match[3].toLowerCase(),
      prefix: `/orchestra/${match[1]}/graphql/${operation}/`,
      endpoint: "",
      variables,
    };
  }

  function parsePersistedPost(url, body) {
    if (!body || typeof body !== "object") return null;
    const operation = body.operationName;
    const hash = body.extensions?.persistedQuery?.sha256Hash;
    if (!operation || typeof hash !== "string" || !/^[a-f0-9]{64}$/i.test(hash)) return null;
    let endpoint = "";
    try {
      endpoint = new URL(String(url), "https://www.walmart.com").toString().split("?")[0];
    } catch {
      endpoint = "";
    }
    return {
      operation,
      method: "POST",
      hash: hash.toLowerCase(),
      prefix: DEFAULTS[operation]?.prefix || "",
      endpoint,
      variables: body.variables && typeof body.variables === "object" ? body.variables : null,
    };
  }

  function discoverFromText(text) {
    const found = {};
    const source = String(text || "");
    const re = /graphql\/(PurchaseHistoryV2|getOrderLedger|getOrder)\/([a-f0-9]{64})/gi;
    let match;
    while ((match = re.exec(source))) {
      const operation = match[1];
      if (!found[operation]) found[operation] = [];
      const hash = match[2].toLowerCase();
      if (!found[operation].includes(hash)) found[operation].push(hash);
    }
    const version = source.match(PLATFORM_VERSION_RE);
    return { hashes: found, platformVersion: version ? version[0] : "" };
  }

  function hashesToTry(operation, captured, discovered) {
    const defaults = DEFAULTS[operation]?.hashes || [];
    const list = [captured, ...(discovered || []), ...defaults].filter(Boolean).map((h) => String(h).toLowerCase());
    return [...new Set(list)];
  }

  function defaultHistoryTemplate() {
    return {
      input: {
        cursor: "",
        search: "",
        filterIds: [],
        limit: HISTORY_LIMIT,
        type: null,
        minTimestamp: null,
        maxTimestamp: null,
      },
      platform: "WEB",
    };
  }

  function richHistoryTemplate() {
    return {
      input: {
        cursor: "",
        search: "",
        filterIds: [],
        limit: HISTORY_LIMIT,
        type: null,
        minTimestamp: null,
        maxTimestamp: null,
      },
      onlyActionableOrders: false,
      enableActionableOrdersSplit: true,
      enableGqlPayloadRefactor: true,
      enableApprovalFlow: false,
      platform: "WEB",
    };
  }

  function historyVariables(template, cursor, limit) {
    const base = template ? structuredClone(template) : defaultHistoryTemplate();
    if (!base.input || typeof base.input !== "object" || Array.isArray(base.input)) base.input = {};
    base.input.cursor = cursor || "";
    base.input.limit = limit;
    base.input.search = "";
    base.input.filterIds = [];
    base.input.type = null;
    base.input.minTimestamp = null;
    base.input.maxTimestamp = null;
    if (Object.prototype.hasOwnProperty.call(base, "onlyActionableOrders")) base.onlyActionableOrders = false;
    return base;
  }

  function historyAttempts(captured, cursor, limit) {
    const attempts = [];
    const push = (template) => {
      const vars = historyVariables(template, cursor, limit);
      const key = JSON.stringify(vars);
      if (!attempts.some((item) => JSON.stringify(item) === key)) attempts.push(vars);
    };
    if (captured) push(captured);
    push(defaultHistoryTemplate());
    push(richHistoryTemplate());
    return attempts;
  }

  function defaultOrderTemplate() {
    return {
      clickThroughGroupId: "0",
      eligibleFeatures: { isEbtEligible: false, isLotOnOdpEnable: false },
      enableCancelFix: false,
      enableGroupBannerMessages: false,
      enableIsWcpOrder: false,
      enableSignOnDelivery: true,
      enableVolumePricing: false,
      enableWcpPhaseOrder: false,
      enabledFeatures: ["csc", "csat-northstar-v1"],
      orderId: "",
      orderIsInStore: false,
    };
  }

  function applyOrderIds(vars, item) {
    const next = structuredClone(vars);
    next.orderId = item.orderId;
    next.orderIsInStore = !!item.inStore;
    if (Object.prototype.hasOwnProperty.call(next, "clickThroughGroupId")) {
      next.clickThroughGroupId = String(item.groupId ?? "0");
    }
    return next;
  }

  function orderAttempts(captured, item) {
    const attempts = [];
    const push = (vars) => {
      const key = JSON.stringify(vars);
      if (!attempts.some((item) => JSON.stringify(item) === key)) attempts.push(vars);
    };
    if (captured) push(applyOrderIds(captured, item));
    push(applyOrderIds(defaultOrderTemplate(), item));
    push({ orderId: item.orderId, orderIsInStore: !!item.inStore });
    return attempts;
  }

  function ledgerAttempts(captured, orderId) {
    const attempts = [];
    const push = (vars) => {
      const key = JSON.stringify(vars);
      if (!attempts.some((item) => JSON.stringify(item) === key)) attempts.push(vars);
    };
    if (captured) {
      const next = structuredClone(captured);
      next.orderId = orderId;
      push(next);
    }
    push({ orderId });
    return attempts;
  }

  function isPersistedQueryMiss(json) {
    const errors = json?.errors;
    if (!Array.isArray(errors)) return false;
    return errors.some((error) => {
      const message = String(error?.message || "");
      const code = String(error?.extensions?.code || "");
      return /persistedquery|persisted query not found|query not found/i.test(message) || code === "PERSISTED_QUERY_NOT_FOUND";
    });
  }

  function isVariableMismatch(json) {
    const errors = json?.errors;
    if (!Array.isArray(errors)) return false;
    return errors.some((error) => /variable/i.test(String(error?.message || "")) && /not defined|not provided|unknown|required/i.test(String(error?.message || "")));
  }

  function classifyResponse(status, json, text) {
    const body = String(text || "");
    if (status === 456 || status === 418) {
      return { kind: "blocked", message: "Walmart blocked further requests. Saved orders are kept. Wait a few minutes, reload the orders page, and continue." };
    }
    if (status === 401 || status === 403) {
      return { kind: "auth", message: "Walmart did not accept this session. Sign in at walmart.com/orders and try again." };
    }
    if (!json && body) {
      if (/robot|captcha|perimeterx|access denied|blocked/i.test(body)) {
        return { kind: "blocked", message: "Walmart blocked further requests. Saved orders are kept. Wait a few minutes, reload the orders page, and continue." };
      }
      if (/sign in|signin|verify it.?s you|enter your password|create your walmart account/i.test(body)) {
        return { kind: "auth", message: "Sign in at walmart.com/orders, wait for the order list, and collect again." };
      }
    }
    if (status === 429 || status === 0 || status >= 500) {
      return { kind: "retry", message: status ? `HTTP ${status}` : "Network error" };
    }
    if (isPersistedQueryMiss(json)) return { kind: "miss", message: "Persisted query was not recognized." };
    if (isVariableMismatch(json)) return { kind: "variables", message: "Query variables did not match this account page." };
    if (status && status !== 200) return { kind: "fail", message: `HTTP ${status}` };
    if (json?.errors?.length && (json.data == null)) {
      return { kind: "fail", message: json.errors.map((error) => error?.message || "GraphQL error").join("; ") };
    }
    return { kind: "ok", message: "" };
  }

  function backoffMs(attempt) {
    return Math.min(30000, 2000 * 2 ** Math.max(0, attempt - 1));
  }

  function unwrapGroups(groups) {
    if (!Array.isArray(groups)) return null;
    if (groups.length && groups.every((item) => item && typeof item === "object" && item.node && !item.orderId && !item.order)) {
      return groups.map((item) => item.node);
    }
    return groups;
  }

  function extractHistoryPage(payload) {
    const errors = Array.isArray(payload?.errors) ? payload.errors : [];
    const data = payload?.data;
    if (!data || typeof data !== "object") return { groups: [], nextCursor: null, errors };
    const nodes = Object.values(data).filter((value) => value && typeof value === "object" && !Array.isArray(value));
    for (const node of nodes) {
      const groups = unwrapGroups(node.orderGroups || node.orders || node.groups);
      if (Array.isArray(groups)) {
        const nextCursor = node.pageInfo?.nextPageCursor || node.pageInfo?.nextCursor || null;
        return { groups, nextCursor: nextCursor || null, errors };
      }
    }
    return { groups: [], nextCursor: null, errors };
  }

  function identityFromGroup(group) {
    if (!group || typeof group !== "object") return { orderId: "", groupId: "0", inStore: false, type: "" };
    const orderId = String(group.orderId || group.orderID || group.order?.id || group.order?.orderId || "");
    const groupId = String(group.groupId ?? group.groupID ?? group.clickThroughGroupId ?? "0");
    const type = String(group.type || group.derivedFulfillmentType || group.fulfillmentType || "");
    const inStore = group.orderIsInStore === true || /IN_STORE/i.test(type);
    return { orderId, groupId, inStore, type };
  }

  function tagGroups(groups, cursor) {
    return (groups || []).map((group, index) => {
      const ident = identityFromGroup(group);
      const orderId = ident.orderId || `unknown-${cursor || "first"}-${index}`;
      return { orderId, groupId: ident.groupId, inStore: ident.inStore, type: ident.type, group };
    });
  }

  function extractOrderNode(json) {
    const data = json?.data;
    if (!data || typeof data !== "object") return null;
    return data.order || data.getOrder || null;
  }

  function mergeOrder(existing, patch) {
    const base = existing || {
      orderId: patch.orderId,
      seq: patch.seq ?? 0,
      summaries: [],
      groupIds: [],
      inStore: false,
      detailResponse: null,
      ledgerResponse: null,
      detailError: "",
      ledgerError: "",
    };
    const summaries = [...(base.summaries || [])];
    for (const group of patch.summaries || []) {
      const ident = identityFromGroup(group);
      const key = `${patch.orderId || ident.orderId}:${ident.groupId}`;
      const index = summaries.findIndex((saved) => {
        const savedIdent = identityFromGroup(saved);
        return `${base.orderId}:${savedIdent.groupId}` === key || `${ident.orderId}:${savedIdent.groupId}` === key;
      });
      if (index >= 0) summaries[index] = group;
      else summaries.push(group);
    }
    const groupIds = [...new Set([...(base.groupIds || []), ...(patch.groupIds || [])].map(String))];
    return {
      orderId: patch.orderId || base.orderId,
      seq: existing?.seq ?? patch.seq ?? 0,
      summaries,
      groupIds,
      inStore: patch.inStore != null ? !!patch.inStore : !!base.inStore,
      detailResponse: patch.detailResponse !== undefined ? patch.detailResponse : base.detailResponse,
      ledgerResponse: patch.ledgerResponse !== undefined ? patch.ledgerResponse : base.ledgerResponse,
      detailError: patch.detailError !== undefined ? patch.detailError : base.detailError || "",
      ledgerError: patch.ledgerError !== undefined ? patch.ledgerError : base.ledgerError || "",
      updatedAt: patch.updatedAt || new Date().toISOString(),
    };
  }

  function walk(node, visit, depth = 0, seen = new Set()) {
    if (!node || typeof node !== "object" || depth > 14 || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) walk(item, visit, depth + 1, seen);
      return;
    }
    visit(node);
    for (const value of Object.values(node)) walk(value, visit, depth + 1, seen);
  }

  function itemName(obj) {
    const name = obj?.productInfo?.name || obj?.name || obj?.itemName;
    if (typeof name !== "string") return "";
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 400 || /^https?:/i.test(trimmed)) return "";
    return trimmed;
  }

  function itemQty(obj) {
    const value = obj?.quantity ?? obj?.qty;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
    return null;
  }

  function itemId(obj) {
    const id = obj?.usItemId || obj?.productInfo?.usItemId || obj?.itemId || obj?.id || "";
    return id == null ? "" : String(id);
  }

  function moneyValue(value) {
    if (value == null) return "";
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number(value.replace(/[$,]/g, ""));
      return Number.isFinite(parsed) ? parsed : value;
    }
    if (typeof value === "object") {
      if (typeof value.value === "number") return value.value;
      if (typeof value.displayValue === "string") return value.displayValue;
    }
    return "";
  }

  function itemPrice(obj) {
    return moneyValue(obj?.priceInfo?.linePrice ?? obj?.priceInfo?.unitPrice ?? obj?.linePrice ?? obj?.price ?? "");
  }

  function findLineItems(root) {
    const items = [];
    const seen = new Set();
    walk(root, (obj) => {
      if (seen.has(obj)) return;
      const name = itemName(obj);
      const quantity = itemQty(obj);
      if (!name || quantity == null) return;
      seen.add(obj);
      items.push({
        name,
        quantity,
        itemId: itemId(obj),
        linePrice: itemPrice(obj),
        image: obj.imageInfo?.thumbnailUrl || obj.productInfo?.imageInfo?.thumbnailUrl || obj.imageUrl || "",
      });
    });
    return items;
  }

  function statusText(group) {
    const parts = group?.status?.message?.parts;
    if (Array.isArray(parts)) return parts.map((part) => part?.text || "").join("").trim();
    if (typeof group?.status?.message === "string") return group.status.message;
    return group?.deliveryMessage || group?.status?.statusType || "";
  }

  function firstOrderDate(record) {
    let found = "";
    walk(record.detailResponse, (obj) => {
      if (!found && (obj.orderDate || obj.orderPlacedDate)) found = obj.orderDate || obj.orderPlacedDate;
    });
    if (found) return found;
    for (const group of record.summaries || []) {
      if (group.orderDate) return group.orderDate;
      if (group.title) return group.title;
    }
    return "";
  }

  function displayIdOf(record) {
    let found = "";
    walk(record.detailResponse, (obj) => {
      if (!found && typeof obj.displayId === "string") found = obj.displayId;
    });
    return found;
  }

  function priceDetailsOf(record) {
    let found = null;
    walk(record.detailResponse, (obj) => {
      if (found) return;
      if (obj.grandTotal || obj.taxTotal || obj.subTotal) found = obj;
    });
    return found || {};
  }

  function paymentText(record) {
    const parts = [];
    const visit = (obj) => {
      if (!Array.isArray(obj.paymentMethods)) return;
      for (const method of obj.paymentMethods) {
        if (method?.description) parts.push(String(method.description));
        else if (method?.paymentType) parts.push(String(method.paymentType));
      }
    };
    walk(record.detailResponse, visit);
    walk(record.ledgerResponse, visit);
    return [...new Set(parts)].join(" | ");
  }

  function trackingNumbers(record) {
    const nums = [];
    walk({ summaries: record.summaries, detail: record.detailResponse }, (obj) => {
      for (const key of ["trackingNumber", "trackingNo"]) {
        const value = obj[key];
        if (typeof value === "string" && value.trim()) nums.push(value.trim());
      }
    });
    return [...new Set(nums)].join(" | ");
  }

  function lineItemsFor(record) {
    const fromDetail = record.detailResponse ? findLineItems(record.detailResponse) : [];
    if (fromDetail.length) return fromDetail;
    return findLineItems(record.summaries || []);
  }

  const CSV_COLUMNS = [
    "order_id",
    "display_id",
    "order_date",
    "group_id",
    "fulfillment_type",
    "in_store",
    "status",
    "store_name",
    "item_name",
    "item_id",
    "quantity",
    "line_price",
    "subtotal",
    "tax",
    "total",
    "payment",
    "tracking",
    "image_url",
  ];

  function csvCell(value) {
    let text = value == null ? "" : String(value);
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
  }

  function ordersToCsv(orders) {
    const lines = [CSV_COLUMNS.join(",")];
    for (const record of orders || []) {
      const prices = priceDetailsOf(record);
      const items = lineItemsFor(record);
      const rows = items.length ? items : [{ name: "", quantity: "", itemId: "", linePrice: "", image: "" }];
      const group = record.summaries?.[0] || {};
      const shared = {
        order_id: record.orderId || "",
        display_id: displayIdOf(record),
        order_date: firstOrderDate(record),
        group_id: (record.groupIds || []).join(" | "),
        fulfillment_type: group.derivedFulfillmentType || group.fulfillmentType || group.type || "",
        in_store: record.inStore ? "yes" : "no",
        status: (record.summaries || []).map(statusText).filter(Boolean).join(" | "),
        store_name: group.store?.name || "",
        subtotal: moneyValue(prices.subTotal),
        tax: moneyValue(prices.taxTotal),
        total: moneyValue(prices.grandTotal),
        payment: paymentText(record),
        tracking: trackingNumbers(record),
      };
      for (const item of rows) {
        const row = {
          ...shared,
          item_name: item.name,
          item_id: item.itemId,
          quantity: item.quantity,
          line_price: item.linePrice,
          image_url: item.image || "",
        };
        lines.push(CSV_COLUMNS.map((column) => csvCell(row[column])).join(","));
      }
    }
    return `\uFEFF${lines.join("\r\n")}\r\n`;
  }

  function buildExport(orders, pages) {
    return {
      source: "https://www.walmart.com/orders",
      exportedAt: new Date().toISOString(),
      generator: "walmart-order-history",
      orderCount: (orders || []).length,
      historyPageCount: (pages || []).length,
      historyPages: (pages || []).map((page) => page.response),
      orders: orders || [],
    };
  }

  function fileStamp(date) {
    return new Date(date || Date.now()).toISOString().slice(0, 10);
  }

  function rankScriptUrls(urls) {
    const high = [];
    const low = [];
    for (const url of urls || []) {
      if (/order|cph|purchase|orchestra|account/i.test(url)) high.push(url);
      else low.push(url);
    }
    return [...high, ...low].slice(0, 30);
  }

  function emptyMeta() {
    return {
      id: "run",
      phase: "idle",
      cursor: "",
      historyDone: false,
      pages: 0,
      orderCount: 0,
      detailCount: 0,
      ledgerCount: 0,
      lastError: "",
      message: "Open walmart.com/orders while signed in.",
      options: { details: true, ledger: true },
      updatedAt: null,
      nextSeq: 1,
    };
  }

  async function collectAccount(job, deps) {
    const limit = job.limit || HISTORY_LIMIT;
    const safety = job.safetyPages || SAFETY_PAGES_PER_RUN;
    const options = job.options || { details: true, ledger: true };
    const pending = new Map();
    const haveDetail = new Set(job.haveDetailIds || []);
    const haveLedger = new Set(job.haveLedgerIds || []);
    for (const item of job.detailQueue || []) {
      if (!haveDetail.has(item.orderId)) pending.set(item.orderId, item);
    }
    let cursor = job.historyDone ? "" : job.cursor || "";
    let pagesThisRun = 0;
    let emptyStreak = 0;

    if (!job.historyDone) {
      while (!deps.isStopped()) {
        if (pagesThisRun >= safety) {
          await deps.emit({ type: "paused", cursor, message: `Paused after ${safety} pages. Continue to keep going.` });
          return { phase: "paused" };
        }
        const attempts = historyAttempts(job.historyTemplate, cursor, limit);
        const res = await deps.request("history", attempts, { cursor });
        const extracted = extractHistoryPage(res.json);
        if (!extracted.groups.length && extracted.errors.length && !extracted.nextCursor) {
          throw new Error(extracted.errors.map((error) => error?.message || "GraphQL error").join("; "));
        }
        const tagged = tagGroups(extracted.groups, cursor);
        for (const item of tagged) {
          if (options.details && !haveDetail.has(item.orderId) && !String(item.orderId).startsWith("unknown-") && !pending.has(item.orderId)) {
            pending.set(item.orderId, { orderId: item.orderId, groupId: item.groupId, inStore: item.inStore });
          }
        }
        await deps.emit({
          type: "history-page",
          cursorKey: cursor || "__first__",
          nextCursor: extracted.nextCursor,
          tagged,
          response: res.json,
        });
        pagesThisRun += 1;
        if (!extracted.groups.length) emptyStreak += 1;
        else emptyStreak = 0;
        if (!extracted.nextCursor || emptyStreak >= 2) {
          await deps.emit({ type: "history-done", cursor: "" });
          cursor = "";
          break;
        }
        if (extracted.nextCursor === cursor) {
          throw new Error("Walmart repeated the same history cursor, so collection stopped. Saved orders are kept.");
        }
        cursor = extracted.nextCursor;
        await deps.sleep(DELAY_MS.history);
      }
    }

    if (deps.isStopped()) {
      await deps.emit({ type: "stopped", cursor, message: "Stopped. Saved orders are kept." });
      return { phase: "stopped" };
    }

    if (options.details) {
      const queue = [...pending.values()];
      let index = 0;
      for (const item of queue) {
        if (deps.isStopped()) break;
        index += 1;
        await deps.emit({ type: "progress", phase: "details", message: `Order details ${index} of ${queue.length}` });
        try {
          let res = await deps.request("detail", orderAttempts(job.orderTemplate, item), item);
          if (!extractOrderNode(res.json)) {
            const flipped = { ...item, inStore: !item.inStore };
            res = await deps.request("detail", orderAttempts(job.orderTemplate, flipped), flipped);
          }
          const node = extractOrderNode(res.json);
          await deps.emit({
            type: "detail",
            orderId: item.orderId,
            groupId: item.groupId,
            inStore: item.inStore,
            response: res.json,
            error: node ? "" : res.error || "No order detail in the response",
          });
        } catch (error) {
          if (error.code === "blocked" || error.code === "auth" || error.code === "stopped") throw error;
          await deps.emit({
            type: "detail",
            orderId: item.orderId,
            groupId: item.groupId,
            inStore: item.inStore,
            response: null,
            error: error.message || String(error),
          });
        }
        await deps.sleep(DELAY_MS.detail);
      }
    }

    if (deps.isStopped()) {
      await deps.emit({ type: "stopped", cursor, message: "Stopped. Saved orders are kept." });
      return { phase: "stopped" };
    }

    if (options.ledger) {
      const ledgerQueue = new Map();
      for (const item of job.ledgerQueue || []) {
        if (!haveLedger.has(item.orderId)) ledgerQueue.set(item.orderId, item);
      }
      for (const item of pending.values()) {
        if (!haveLedger.has(item.orderId) && !String(item.orderId).startsWith("unknown-")) {
          ledgerQueue.set(item.orderId, { orderId: item.orderId });
        }
      }
      const queue = [...ledgerQueue.values()];
      let index = 0;
      for (const item of queue) {
        if (deps.isStopped()) break;
        index += 1;
        await deps.emit({ type: "progress", phase: "ledger", message: `Payment ledger ${index} of ${queue.length}` });
        try {
          const res = await deps.request("ledger", ledgerAttempts(job.ledgerTemplate, item.orderId), item);
          await deps.emit({
            type: "ledger",
            orderId: item.orderId,
            response: res.json,
            error: res.soft ? res.error || "No ledger" : "",
          });
        } catch (error) {
          if (error.code === "blocked" || error.code === "auth") throw error;
          await deps.emit({ type: "ledger", orderId: item.orderId, response: null, error: error.message || String(error) });
        }
        await deps.sleep(DELAY_MS.ledger);
      }
    }

    if (deps.isStopped()) {
      await deps.emit({ type: "stopped", cursor: "", message: "Stopped. Saved orders are kept." });
      return { phase: "stopped" };
    }
    await deps.emit({ type: "done", message: "Full history saved in this browser." });
    return { phase: "done" };
  }

  return {
    DELAY_MS,
    SAFETY_PAGES_PER_RUN,
    HISTORY_LIMIT,
    DEFAULTS,
    CSV_COLUMNS,
    isOrdersListUrl,
    parseOperationUrl,
    parsePersistedPost,
    discoverFromText,
    hashesToTry,
    defaultHistoryTemplate,
    richHistoryTemplate,
    historyVariables,
    historyAttempts,
    defaultOrderTemplate,
    orderAttempts,
    ledgerAttempts,
    classifyResponse,
    backoffMs,
    extractHistoryPage,
    identityFromGroup,
    tagGroups,
    extractOrderNode,
    mergeOrder,
    findLineItems,
    statusText,
    ordersToCsv,
    buildExport,
    fileStamp,
    rankScriptUrls,
    emptyMeta,
    collectAccount,
    walk,
  };
});
