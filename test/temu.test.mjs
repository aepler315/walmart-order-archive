import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const protocol = require("../src/lib/temu.js");

test("recognizes the Temu orders page and keeps order detail pages out", () => {
  assert.equal(protocol.isOrdersListUrl("https://www.temu.com/bgt_orders.html?_x_sessn_id=b1oeo2u704&refer_page_name=bgt_orders"), true);
  assert.equal(protocol.isOrdersListUrl("https://temu.com/w/bgt_orders.html"), true);
  assert.equal(protocol.isOrdersListUrl("https://www.temu.com/ca/bgt_orders.html"), true);
  assert.equal(protocol.isOrdersListUrl("https://eviltemu.com/bgt_orders.html"), false);
  assert.equal(protocol.isOrdersListUrl("https://www.temu.com/bgt_order_detail.html?parent_order_sn=PO-1"), false);
  assert.equal(protocol.isOrdersListUrl("https://www.walmart.com/orders"), false);
});

test("reads a camelCase orders page and the next cursor", () => {
  const page = {
    viewOrders: [
      { parentOrderSn: "PO-1", parentStatusDesc: "Delivered", goodsList: [{ goodsName: "Mug", skuId: "9", goodsNumber: 2, thumbUrl: "https://img.example/mug.jpg", priceDesc: { displayAmountWithSymbol: "$4.00" } }] },
      { parent_order_sn: "PO-2" },
    ],
    hasNextPage: true,
    offset: "cursor-2",
    offsetMap: { all: "m" },
    sortValuesMap: { all: "s" },
  };
  const rows = protocol.listOrdersFrom(page);
  assert.equal(rows.length, 2);
  assert.equal(protocol.orderIdOf(rows[0]), "PO-1");
  assert.equal(protocol.orderIdOf(rows[1]), "PO-2");
  const info = protocol.pageInfo(page);
  assert.equal(info.hasNext, true);
  assert.equal(info.offset, "cursor-2");
  const body = protocol.historyBody({ listPage: 2, offset: "cursor-2", offsetMap: { all: "m" }, sortValuesMap: null, listDone: false });
  assert.equal(body.type, "all");
  assert.equal(body.page, 2);
  assert.equal(body.offset, "cursor-2");
  assert.equal(body.offset_map.all, "m");
  assert.equal("sort_values_map" in body, false);
});

test("unwraps a result envelope and return pages", () => {
  const page = { result: { view_orders: [{ parentOrderSn: "PO-3" }], has_next_page: false } };
  assert.equal(protocol.listOrdersFrom(page)[0].parentOrderSn, "PO-3");
  assert.equal(protocol.pageInfo(page).hasNext, false);
  const returns = {
    parentAfterSalesVoList: [{ parentAfterSalesSn: "AS-1", parentOrderSn: "PO-3" }],
    hasNextQuery: true,
    nextQueryCreatedAt: 170000,
  };
  assert.equal(protocol.returnIdOf(protocol.returnRows(returns)[0]), "return:AS-1");
  assert.equal(protocol.returnInfo(returns).cursor, 170000);
});

test("classifies verification, sign-in, and slow-down responses", () => {
  assert.equal(protocol.classifyPayload({ error: { message: "Please complete the security verification" } }).kind, "blocked");
  assert.equal(protocol.classifyPayload({ error_msg: "Please login first" }).kind, "auth");
  assert.equal(protocol.classifyPayload({ errorCode: 40001, errorMsg: "System busy" }).kind, "busy");
  assert.equal(protocol.classifyPayload({ viewOrders: [], hasNextPage: false }).kind, "ok");
  assert.equal(protocol.classifyPayload({ isError: true, errorMsg: "search failed" }).kind, "fail");
});

test("builds a spreadsheet row from list goods and neutralizes formulas", () => {
  const csv = protocol.ordersToCsv([{
    orderId: "PO-1",
    summaries: [{
      parentOrderSn: "PO-1",
      parentOrderTime: 1700000000,
      parentStatusDesc: "Shipped",
      goodsList: [{ goodsName: "=cmd", skuId: "9", goodsNumber: 1, priceDesc: { displayAmount: "3.00", symbol: "$" } }],
    }],
  }]);
  assert.match(csv, /PO-1/);
  assert.match(csv, /'=cmd/);
  assert.match(csv, /\$3\.00/);
  assert.match(csv, /2023-11-14/);
});

test("walks the whole account, then details and payments, and resumes cleanly", async () => {
  const calls = [];
  const saved = [];
  const pages = [
    { viewOrders: [{ parentOrderSn: "PO-1", goodsList: [{ goodsName: "Mug" }] }], hasNextPage: true, offset: "a" },
    { viewOrders: [{ parentOrderSn: "PO-2" }], hasNextPage: false, offset: "b" },
  ];
  await protocol.collectAccount({
    cursor: "",
    historyDone: false,
    options: { details: true, ledger: true, returns: true },
    detailQueue: [],
    ledgerQueue: [],
    haveDetailIds: ["PO-1"],
    haveLedgerIds: [],
    safetyPages: 20,
  }, {
    async request(kind, body) {
      calls.push(`${kind}:${body.parent_order_sn || body.page || body.last_query_min_created_at || "start"}`);
      if (kind === "list") return { json: pages.shift() };
      if (kind === "returns") return { json: { parentAfterSalesVoList: [], hasNextQuery: false } };
      if (kind === "detail" && body.parent_order_sn === "PO-2") return { json: { orderInfoList: [{ goodsName: "Lamp" }] } };
      if (kind === "payment") return { json: { payAmountDisplay: "$8.00" } };
      return { json: {} };
    },
    async sleep() {},
    async emit(payload) { saved.push(payload.type + ":" + (payload.orderId || payload.cursorKey || "")); },
    isStopped() { return false; },
  });
  assert.deepEqual(calls.filter((call) => call.startsWith("detail:")), ["detail:PO-2"]);
  assert.ok(calls.includes("payment:PO-1"));
  assert.ok(calls.includes("payment:PO-2"));
  assert.ok(saved.includes("done:"));
  assert.equal(saved.filter((item) => item.startsWith("history-page:")).length, 3);
});

test("stops when Temu repeats a cursor and pauses at the page cap before details", async () => {
  await assert.rejects(protocol.collectAccount({
    cursor: "",
    historyDone: false,
    options: { details: true, ledger: false, returns: false },
    safetyPages: 10,
  }, {
    async request() {
      return { json: { viewOrders: [{ parentOrderSn: "PO-9" }], hasNextPage: true, offset: "same" } };
    },
    async sleep() {},
    async emit() {},
    isStopped() { return false; },
  }), (error) => error.code === "stuck");

  const calls = [];
  await protocol.collectAccount({
    cursor: "",
    historyDone: false,
    options: { details: true, ledger: true, returns: false },
    safetyPages: 1,
  }, {
    async request(kind) {
      calls.push(kind);
      return { json: { viewOrders: [{ parentOrderSn: "PO-1" }], hasNextPage: true, offset: "next" } };
    },
    async sleep() {},
    async emit() {},
    isStopped() { return false; },
  });
  assert.deepEqual(calls, ["list"]);
});
