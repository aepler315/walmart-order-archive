/* Temu orders-page protocol. The page's own client sends the signed-in session. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.TMHProtocol = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const DELAY_MS = { history: 700, detail: 450, payment: 450 };
  const PAGE_SIZE = 10;
  const SAFETY_PAGES_PER_RUN = 500;
  const LIST_EXTRA = {
    support_change_payment: true,
    order_list_show_wait_pay_info: 1,
    need_new_delivery_shipping_module: 1,
    co_addr: true,
    shop_co_addr: true,
    show_new_guide_change_payment_desc: 1,
    need_after_sales_display_vo: 1,
    unify_style_support_mode: true,
    show_unboxing_video: 1,
  };
  const CSV_COLUMNS = [
    "order_id",
    "kind",
    "order_date",
    "status",
    "item_name",
    "sku",
    "quantity",
    "item_price",
    "order_total",
    "currency",
    "tracking",
    "image_url",
  ];

  function isOrdersListUrl(url) {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      const temuHost = host === "temu.com" || host.endsWith(".temu.com");
      if (!temuHost) return false;
      return parsed.pathname.toLowerCase().includes("bgt_orders");
    } catch {
      return false;
    }
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
      nextSeq: 1,
      message: "",
      lastError: "",
      options: { details: true, ledger: true, returns: true },
    };
  }

  function emptyCursor() {
    return {
      listPage: 1,
      offset: null,
      offsetMap: null,
      sortValuesMap: null,
      listDone: false,
      returnsCursor: null,
      returnsDone: false,
    };
  }

  function parseCursor(cursor) {
    const base = emptyCursor();
    if (!cursor) return base;
    try {
      const parsed = JSON.parse(cursor);
      if (!parsed || typeof parsed !== "object") return base;
      return { ...base, ...parsed };
    } catch {
      return base;
    }
  }

  function unwrap(json) {
    if (!json || typeof json !== "object") return {};
    const result = json.result;
    if (result && typeof result === "object" && !Array.isArray(result)) {
      if (result.viewOrders || result.view_orders || result.parentAfterSalesVoList || result.parent_after_sales_vo_list || "hasNextPage" in result || "has_next_page" in result || "hasNextQuery" in result) {
        return result;
      }
    }
    return json;
  }

  function listOrdersFrom(json) {
    const body = unwrap(json);
    const rows = body.viewOrders || body.view_orders || [];
    return Array.isArray(rows) ? rows.filter((row) => row && typeof row === "object") : [];
  }

  function pageInfo(json) {
    const body = unwrap(json);
    return {
      hasNext: !!(body.hasNextPage ?? body.has_next_page),
      offset: body.offset ?? null,
      offsetMap: body.offsetMap ?? body.offset_map ?? null,
      sortValuesMap: body.sortValuesMap ?? body.sort_values_map ?? null,
    };
  }

  function returnRows(json) {
    const body = unwrap(json);
    const rows = body.parentAfterSalesVoList || body.parent_after_sales_vo_list || [];
    return Array.isArray(rows) ? rows.filter((row) => row && typeof row === "object") : [];
  }

  function returnInfo(json) {
    const body = unwrap(json);
    return {
      hasNext: !!(body.hasNextQuery ?? body.has_next_query),
      cursor: body.nextQueryCreatedAt ?? body.next_query_created_at ?? null,
    };
  }

  function orderIdOf(row) {
    if (!row || typeof row !== "object") return "";
    const value = row.parentOrderSn || row.parent_order_sn || row.combineOrderSn || row.combine_order_sn || "";
    return String(value || "").trim();
  }

  function returnIdOf(row) {
    if (!row || typeof row !== "object") return "";
    const value = row.parentAfterSalesSn || row.parent_after_sales_sn || row.parentOrderSn || row.parent_order_sn || "";
    const text = String(value || "").trim();
    return text ? `return:${text}` : "";
  }

  function historyBody(cursor) {
    const body = {
      page: cursor.listPage || 1,
      size: PAGE_SIZE,
      type: "all",
      extra_map: { ...LIST_EXTRA },
    };
    if (cursor.offset) body.offset = cursor.offset;
    if (cursor.offsetMap) body.offset_map = cursor.offsetMap;
    if (cursor.sortValuesMap) body.sort_values_map = cursor.sortValuesMap;
    return body;
  }

  function detailBody(orderId) {
    return {
      parent_order_sn: orderId,
      ord_auth: 0,
      without_timezone_intercept: false,
      without_timezone_degrade: true,
      extra_map: {
        co_addr: true,
        shop_co_addr: true,
        unify_style_support_mode: true,
        special_use_version: 500,
        need_after_sales_display_vo: 1,
        show_unboxing_video: 1,
        risk_appeal_mode: 1,
      },
      useAntiToken: true,
    };
  }

  function paymentBody(orderId) {
    return { parent_order_sn: orderId, useAntiToken: true };
  }

  function classifyPayload(json) {
    if (!json || typeof json !== "object") return { kind: "fail", message: "Temu returned an empty response." };
    const error = json.error && typeof json.error === "object" ? json.error : {};
    const code = Number(error.errorCode || error.error_code || json.errorCode || json.error_code || 0);
    const message = String(error.message || json.errorMsg || json.error_msg || "");
    if (/captcha|verify your identity|security verification|robot/i.test(message)) {
      return { kind: "blocked", message: message || "Temu asked for a verification check." };
    }
    if (/sign in|log in|please login|login first/i.test(message)) {
      return { kind: "auth", message: message || "Sign in to Temu and reload the orders page." };
    }
    if (code === 40001 || /system busy/i.test(message)) {
      return { kind: "busy", message: message || "Temu asked to slow down." };
    }
    if (json.isError) return { kind: "fail", message: message || "Temu could not return this page." };
    return { kind: "ok" };
  }

  function walk(value, visit, depth, maxDepth) {
    if (!value || typeof value !== "object" || depth > maxDepth) return;
    if (!Array.isArray(value)) visit(value);
    const children = Array.isArray(value) ? value : Object.values(value);
    for (const child of children) {
      if (child && typeof child === "object") walk(child, visit, depth + 1, maxDepth);
    }
  }

  function priceText(obj) {
    const desc = obj.priceDesc || obj.price_desc || obj.goodsPrice || obj.goods_price || {};
    const source = desc && typeof desc === "object" ? desc : {};
    if (source.displayAmountWithSymbol) return String(source.displayAmountWithSymbol);
    if (source.symbol && source.displayAmount != null && source.displayAmount !== "") {
      return source.symbolBefore === false ? `${source.displayAmount}${source.symbol}` : `${source.symbol}${source.displayAmount}`;
    }
    const direct = source.customizedDisplayAmount || source.displayAmount || obj.displayAmount || obj.orderAmount || "";
    if (direct) return String(direct);
    if (typeof obj.goodsPrice === "number" || typeof obj.goodsPrice === "string") return String(obj.goodsPrice);
    return "";
  }

  function findGoods(record) {
    const sources = [];
    if (record?.detailResponse) sources.push(record.detailResponse);
    if (record?.summaries) sources.push(record.summaries);
    const goods = [];
    const seen = new Set();
    for (const source of sources) {
      walk(source, (obj) => {
        const name = obj.goodsName || obj.goods_name || obj.skuName || obj.sku_name;
        if (!name) return;
        const sku = String(obj.skuId || obj.sku_id || obj.goodsId || obj.goods_id || "");
        const key = `${name}\u0000${sku}`;
        if (seen.has(key)) return;
        seen.add(key);
        goods.push({
          name: String(name),
          sku,
          quantity: obj.goodsNumber ?? obj.goods_number ?? obj.quantity ?? "",
          price: priceText(obj),
          image: obj.thumbUrl || obj.thumb_url || obj.imageUrl || obj.image_url || "",
        });
      }, 0, 8);
    }
    return goods;
  }

  function firstText(record, names) {
    let found = "";
    const sources = [record?.summaries, record?.detailResponse, record?.ledgerResponse];
    for (const source of sources) {
      if (found) break;
      walk(source, (obj) => {
        if (found) return;
        for (const name of names) {
          const value = obj[name];
          if (value == null || value === "") continue;
          if (typeof value === "string" || typeof value === "number") {
            found = String(value);
            return;
          }
        }
      }, 0, 8);
    }
    return found;
  }

  function orderDate(record) {
    const numeric = firstText(record, ["parentOrderTime", "parent_order_time", "orderTime", "order_time", "createdAt", "createTime"]);
    if (/^\d{10,13}$/.test(numeric)) {
      const ms = numeric.length === 13 ? Number(numeric) : Number(numeric) * 1000;
      const date = new Date(ms);
      if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
    }
    return firstText(record, ["orderDate", "order_date", "parentOrderDate", "displayOrderTime", "display_order_time"]) || numeric;
  }

  function statusText(record) {
    return firstText(record, [
      "parentOrderStatusDesc",
      "parent_order_status_desc",
      "orderStatusPrompt",
      "statusPrompt",
      "statusDesc",
      "parentStatusDesc",
      "parent_status_desc",
      "orderStatus",
      "parentStatus",
    ]);
  }

  function orderTotal(record) {
    return firstText(record, ["displayParentOrderAmount", "parentOrderAmountDisplay", "totalAmountDisplay", "payAmountDisplay", "orderAmountDisplay"]);
  }

  function trackingText(record) {
    const numbers = [];
    walk(record?.detailResponse || record?.summaries, (obj) => {
      const value = obj.trackingNumber || obj.tracking_number || obj.waybillNo || obj.waybill_no || obj.packageSn || obj.package_sn;
      if (value && !numbers.includes(String(value))) numbers.push(String(value));
    }, 0, 8);
    return numbers.join(" | ");
  }

  function csvCell(value) {
    let text = value == null ? "" : String(value);
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
  }

  function ordersToCsv(orders) {
    const lines = [CSV_COLUMNS.join(",")];
    for (const record of orders || []) {
      const items = findGoods(record);
      const rows = items.length ? items : [{ name: "", sku: "", quantity: "", price: "", image: "" }];
      const shared = {
        order_id: record.orderId || "",
        kind: String(record.orderId || "").startsWith("return:") ? "return" : "order",
        order_date: orderDate(record),
        status: statusText(record),
        order_total: orderTotal(record),
        currency: firstText(record, ["currency", "currencyCode"]),
        tracking: trackingText(record),
      };
      for (const item of rows) {
        lines.push(CSV_COLUMNS.map((column) => csvCell({
          ...shared,
          item_name: item.name,
          sku: item.sku,
          quantity: item.quantity,
          item_price: item.price,
          image_url: item.image,
        }[column])).join(","));
      }
    }
    return `\uFEFF${lines.join("\r\n")}\r\n`;
  }

  function buildExport(orders, pages) {
    return {
      store: "temu",
      exportedAt: new Date().toISOString(),
      source: "https://www.temu.com/bgt_orders.html",
      orderCount: (orders || []).length,
      orders: orders || [],
      pages: pages || [],
    };
  }

  function fileStamp() {
    return new Date().toISOString().slice(0, 10);
  }

  function pageKey(info) {
    return JSON.stringify([info.offset ?? null, info.offsetMap ?? null, info.sortValuesMap ?? null]);
  }

  async function collectAccount(job, deps) {
    const cursor = parseCursor(job.historyDone ? "" : job.cursor);
    const options = job.options || {};
    const safety = job.safetyPages || SAFETY_PAGES_PER_RUN;
    let pagesThisRun = 0;
    const pending = new Set((job.detailQueue || []).map((item) => item.orderId || item));
    const payQueue = new Set((job.ledgerQueue || []).map((item) => item.orderId || item));
    const haveDetail = new Set(job.haveDetailIds || []);
    const havePay = new Set(job.haveLedgerIds || []);

    function noteOrder(orderId) {
      if (!orderId || String(orderId).startsWith("unknown-") || String(orderId).startsWith("return:")) return;
      if (!haveDetail.has(orderId)) pending.add(orderId);
      if (!havePay.has(orderId)) payQueue.add(orderId);
    }

    async function stopOrPause(kind, message) {
      await deps.emit({ type: kind, store: "temu", cursor: JSON.stringify(cursor), message });
    }

    if (!job.historyDone) {
      if (!cursor.listDone) {
        let previousKey = "";
        let emptyStreak = 0;
        while (!deps.isStopped()) {
          if (pagesThisRun >= safety) {
            await stopOrPause("paused", `Paused after ${safety} pages. Continue to keep going.`);
            return;
          }
          const result = await deps.request("list", historyBody(cursor));
          const rows = listOrdersFrom(result.json);
          const info = pageInfo(result.json);
          const tagged = rows.map((row, index) => ({
            orderId: orderIdOf(row) || `unknown-${cursor.listPage}-${index}`,
            summary: row,
            kind: "order",
          }));
          const next = {
            ...cursor,
            listPage: (cursor.listPage || 1) + 1,
            offset: info.offset,
            offsetMap: info.offsetMap,
            sortValuesMap: info.sortValuesMap,
            listDone: !info.hasNext,
          };
          await deps.emit({
            type: "history-page",
            store: "temu",
            cursorKey: `list:${cursor.listPage}`,
            nextCursor: JSON.stringify(next),
            tagged,
            response: result.json,
          });
          for (const item of tagged) noteOrder(item.orderId);
          pagesThisRun += 1;
          Object.assign(cursor, next);
          if (!info.hasNext) break;
          if (!rows.length) {
            emptyStreak += 1;
            if (emptyStreak >= 2) {
              cursor.listDone = true;
              break;
            }
          } else {
            emptyStreak = 0;
          }
          const key = pageKey(info);
          if (previousKey && key === previousKey) {
            const error = new Error("Temu repeated the same orders page.");
            error.code = "stuck";
            throw error;
          }
          previousKey = key;
          await deps.sleep(DELAY_MS.history);
        }
      }
      if (deps.isStopped()) {
        await stopOrPause("stopped", "Stopped. Saved orders are kept.");
        return;
      }
      if (options.returns !== false && !cursor.returnsDone) {
        let previous = "";
        let emptyStreak = 0;
        while (!deps.isStopped()) {
          if (pagesThisRun >= safety) {
            await stopOrPause("paused", `Paused after ${safety} pages. Continue to keep going.`);
            return;
          }
          const result = await deps.request("returns", {
            limit: PAGE_SIZE,
            last_query_min_created_at: cursor.returnsCursor ?? null,
            useAntiToken: true,
          });
          const rows = returnRows(result.json);
          const info = returnInfo(result.json);
          const tagged = rows.map((row, index) => ({
            orderId: returnIdOf(row) || `unknown-return-${cursor.returnsCursor || "start"}-${index}`,
            summary: row,
            kind: "return",
          }));
          const next = { ...cursor, returnsCursor: info.cursor, returnsDone: !info.hasNext };
          await deps.emit({
            type: "history-page",
            store: "temu",
            cursorKey: `returns:${cursor.returnsCursor || "start"}`,
            nextCursor: JSON.stringify(next),
            tagged,
            response: result.json,
          });
          pagesThisRun += 1;
          Object.assign(cursor, next);
          if (!info.hasNext) break;
          if (!rows.length) {
            emptyStreak += 1;
            if (emptyStreak >= 2) {
              cursor.returnsDone = true;
              break;
            }
          } else {
            emptyStreak = 0;
          }
          const key = String(info.cursor ?? "");
          if (previous && key === previous) {
            const error = new Error("Temu repeated the same returns page.");
            error.code = "stuck";
            throw error;
          }
          previous = key;
          await deps.sleep(DELAY_MS.history);
        }
      } else {
        cursor.returnsDone = true;
      }
      if (deps.isStopped()) {
        await stopOrPause("stopped", "Stopped. Saved orders are kept.");
        return;
      }
      await deps.emit({ type: "history-done", store: "temu" });
    }

    if (options.details !== false) {
      for (const orderId of pending) {
        if (deps.isStopped()) {
          await stopOrPause("stopped", "Stopped. Saved orders are kept.");
          return;
        }
        if (haveDetail.has(orderId)) continue;
        try {
          const result = await deps.request("detail", detailBody(orderId));
          await deps.emit({
            type: "detail",
            store: "temu",
            orderId,
            response: result.soft ? null : result.json,
            error: result.error || "",
          });
        } catch (error) {
          if (error.code === "blocked" || error.code === "auth" || error.code === "stopped") throw error;
          await deps.emit({ type: "detail", store: "temu", orderId, error: error.message || String(error) });
        }
        await deps.sleep(DELAY_MS.detail);
      }
    }

    if (options.ledger !== false) {
      for (const orderId of payQueue) {
        if (deps.isStopped()) {
          await stopOrPause("stopped", "Stopped. Saved orders are kept.");
          return;
        }
        if (havePay.has(orderId)) continue;
        try {
          const result = await deps.request("payment", paymentBody(orderId));
          await deps.emit({
            type: "ledger",
            store: "temu",
            orderId,
            response: result.soft ? null : result.json,
            error: result.error || "",
          });
        } catch (error) {
          if (error.code === "blocked" || error.code === "auth" || error.code === "stopped") throw error;
          await deps.emit({ type: "ledger", store: "temu", orderId, error: error.message || String(error) });
        }
        await deps.sleep(DELAY_MS.payment);
      }
    }

    if (deps.isStopped()) {
      await stopOrPause("stopped", "Stopped. Saved orders are kept.");
      return;
    }
    await deps.emit({ type: "done", store: "temu", message: "Full Temu history saved in this browser." });
  }

  return {
    DELAY_MS,
    PAGE_SIZE,
    SAFETY_PAGES_PER_RUN,
    CSV_COLUMNS,
    isOrdersListUrl,
    emptyMeta,
    parseCursor,
    listOrdersFrom,
    pageInfo,
    returnRows,
    returnInfo,
    orderIdOf,
    returnIdOf,
    historyBody,
    detailBody,
    paymentBody,
    classifyPayload,
    findGoods,
    orderDate,
    statusText,
    orderTotal,
    ordersToCsv,
    buildExport,
    fileStamp,
    collectAccount,
    walk,
  };
});
