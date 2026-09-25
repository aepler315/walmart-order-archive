import { createRequire } from "node:module";
import assert from "node:assert/strict";
import test from "node:test";

const protocol = createRequire(import.meta.url)("../src/lib/protocol.js");

const historyUrl = "https://www.walmart.com/orchestra/cph/graphql/PurchaseHistoryV2/2c3d5a832b56671dca1ed0ec84940f274d0bc80821db4ad7481e496c0ad5847e?variables=" + encodeURIComponent(JSON.stringify({
  input: { cursor: "", search: "milk", filterIds: ["last-year"], limit: 10, minTimestamp: 10, maxTimestamp: 20 },
  onlyActionableOrders: true,
  platform: "WEB",
}));

test("orders list url is only the account orders page", () => {
  assert.equal(protocol.isOrdersListUrl("https://www.walmart.com/orders"), true);
  assert.equal(protocol.isOrdersListUrl("https://www.walmart.com/orders/"), true);
  assert.equal(protocol.isOrdersListUrl("https://www.walmart.com/orders?foo=1"), true);
  assert.equal(protocol.isOrdersListUrl("https://www.walmart.com/orders/123"), false);
  assert.equal(protocol.isOrdersListUrl("https://www.walmart.com/"), false);
});

test("parses persisted query urls without mixing getOrder and getOrderLedger", () => {
  const history = protocol.parseOperationUrl(historyUrl);
  assert.equal(history.operation, "PurchaseHistoryV2");
  assert.equal(history.hash, "2c3d5a832b56671dca1ed0ec84940f274d0bc80821db4ad7481e496c0ad5847e");
  assert.equal(history.variables.input.filterIds[0], "last-year");
  assert.equal(history.prefix, "/orchestra/cph/graphql/PurchaseHistoryV2/");

  const ledger = protocol.parseOperationUrl("https://www.walmart.com/orchestra/orders/graphql/getOrderLedger/1234d48bfc5e62b608c0dae2c5752f31978870456bcf0023bad3988009e70919");
  assert.equal(ledger.operation, "getOrderLedger");
  const order = protocol.parseOperationUrl("https://www.walmart.com/orchestra/orders/graphql/getOrder/0d0e73dcfbe4c7a4cb6c8ce929e5b9a8b3e731e4bac81969eed76dbdab28b0d2");
  assert.equal(order.operation, "getOrder");
});

test("parses a persisted POST body", () => {
  const parsed = protocol.parsePersistedPost("https://www.walmart.com/orchestra/cph/graphql", {
    operationName: "PurchaseHistoryV2",
    variables: { input: { cursor: "c" } },
    extensions: { persistedQuery: { sha256Hash: "a".repeat(64) } },
  });
  assert.equal(parsed.method, "POST");
  assert.equal(parsed.variables.input.cursor, "c");
  assert.equal(protocol.parsePersistedPost("https://www.walmart.com/orchestra/cph/graphql", { operationName: "PurchaseHistoryV2" }), null);
});

test("finds hashes in a script and keeps the longer operation name", () => {
  const text = `
    graphql/getOrderLedger/${"ab".repeat(32)}
    graphql/getOrder/${"cd".repeat(32)}
    platform usweb-1.284.0-1871dae08edcd429b12e47a369da9967df5b330d-7141058r
  `;
  const found = protocol.discoverFromText(text);
  assert.deepEqual(found.hashes.getOrderLedger, ["ab".repeat(32)]);
  assert.deepEqual(found.hashes.getOrder, ["cd".repeat(32)]);
  assert.match(found.platformVersion, /^usweb-1\.284\.0-/);
});

test("history attempts drop the on-page date filter", () => {
  const captured = protocol.parseOperationUrl(historyUrl).variables;
  const [first] = protocol.historyAttempts(captured, "next", 20);
  assert.equal(first.input.cursor, "next");
  assert.equal(first.input.limit, 20);
  assert.deepEqual(first.input.filterIds, []);
  assert.equal(first.input.search, "");
  assert.equal(first.input.minTimestamp, null);
  assert.equal(first.input.maxTimestamp, null);
  assert.equal(first.onlyActionableOrders, false);
});

test("order attempts overwrite the captured order id", () => {
  const attempts = protocol.orderAttempts(
    { orderId: "old", orderIsInStore: true, clickThroughGroupId: "9", enabledFeatures: ["csc"] },
    { orderId: "new", groupId: "2", inStore: false },
  );
  assert.equal(attempts[0].orderId, "new");
  assert.equal(attempts[0].orderIsInStore, false);
  assert.equal(attempts[0].clickThroughGroupId, "2");
  assert.deepEqual(attempts[0].enabledFeatures, ["csc"]);
});

test("classifies auth, bot checks, and stale query hashes", () => {
  assert.equal(protocol.classifyResponse(456, null, "").kind, "blocked");
  assert.equal(protocol.classifyResponse(429, null, "").kind, "retry");
  assert.equal(protocol.classifyResponse(401, null, "").kind, "auth");
  assert.equal(protocol.classifyResponse(200, null, "<html>sign in to your account</html>").kind, "auth");
  assert.equal(protocol.classifyResponse(200, { errors: [{ message: "PersistedQueryNotFound" }] }, "").kind, "miss");
  assert.equal(protocol.classifyResponse(200, { errors: [{ message: "Variable x is not defined" }] }, "").kind, "variables");
  assert.equal(protocol.backoffMs(1), 2000);
  assert.equal(protocol.backoffMs(2), 4000);
  assert.equal(protocol.backoffMs(20), 30000);
});

test("extracts cursor pages and tags orders that have no id", () => {
  const page = protocol.extractHistoryPage({
    data: {
      orderHistoryV2: {
        pageInfo: { nextPageCursor: "cursor-2" },
        orderGroups: [
          { type: "IN_STORE", orderId: "111", groupId: "0", items: [{ id: "sku1", quantity: 2, name: "Milk" }] },
          { type: "GLASS", orderId: "222", groupId: "1", derivedFulfillmentType: "SC_DELIVERY", items: [{ quantity: 1, productInfo: { name: "Bread", usItemId: "999" } }] },
          { type: "GLASS", items: [] },
        ],
      },
    },
  });
  assert.equal(page.nextCursor, "cursor-2");
  const tagged = protocol.tagGroups(page.groups, "");
  assert.equal(tagged[0].inStore, true);
  assert.equal(tagged[1].inStore, false);
  assert.equal(tagged[2].orderId, "unknown-first-2");
  const edges = protocol.extractHistoryPage({
    data: { purchaseHistory: { pageInfo: {}, orders: [{ node: { orderId: "333", groupId: "0", type: "IN_STORE" } }] } },
  });
  assert.equal(edges.groups[0].orderId, "333");
});

test("merges shipment groups onto one order without dropping detail", () => {
  const first = protocol.mergeOrder(null, {
    orderId: "111",
    seq: 1,
    summaries: [{ orderId: "111", groupId: "0", items: [{ name: "Milk", quantity: 1 }] }],
    groupIds: ["0"],
    inStore: true,
  });
  const second = protocol.mergeOrder(first, {
    orderId: "111",
    summaries: [{ orderId: "111", groupId: "1", items: [{ name: "Bread", quantity: 1 }] }],
    groupIds: ["1"],
    detailResponse: { data: { order: { id: "111" } } },
  });
  assert.equal(second.summaries.length, 2);
  assert.equal(second.detailResponse.data.order.id, "111");
  assert.deepEqual(second.groupIds, ["0", "1"]);
  const replaced = protocol.mergeOrder(second, {
    orderId: "111",
    summaries: [{ orderId: "111", groupId: "0", items: [{ name: "Milk 2%", quantity: 1 }] }],
  });
  assert.equal(replaced.summaries.length, 2);
  assert.equal(replaced.summaries[0].items[0].name, "Milk 2%");
  assert.equal(replaced.detailResponse.data.order.id, "111");
});

test("csv keeps raw json fields flattened and neutralizes formulas", () => {
  const csv = protocol.ordersToCsv([{
    orderId: "222",
    inStore: false,
    groupIds: ["1"],
    summaries: [{
      orderId: "222",
      groupId: "1",
      type: "GLASS",
      derivedFulfillmentType: "SC_DELIVERY",
      store: { name: "Meridian Supercenter" },
      status: { statusType: "DELIVERED", message: { parts: [{ text: "Delivered" }] } },
      items: [{ name: "Summary only", quantity: 4 }],
    }],
    detailResponse: {
      data: {
        order: {
          id: "222",
          displayId: "222-1",
          orderDate: "2025-09-05T20:16:00.000Z",
          groups_2101: [{
            items: [{
              quantity: 1,
              productInfo: { name: "=Bread", usItemId: "999" },
              priceInfo: { linePrice: { value: 1.97 } },
              trackingNumber: "1Z999",
            }],
          }],
          priceDetails: { subTotal: { value: 1.97 }, taxTotal: { value: 0.12 }, grandTotal: { value: 2.09 } },
          paymentMethods: [{ description: "Ending in 0953" }],
        },
      },
    },
    ledgerResponse: null,
  }]);
  assert.ok(csv.startsWith("\uFEFF"));
  assert.match(csv, /order_id,display_id/);
  assert.match(csv, /222-1/);
  assert.match(csv, /'=Bread/);
  assert.match(csv, /1Z999/);
  assert.match(csv, /Ending in 0953/);
  assert.doesNotMatch(csv, /Summary only/);
  assert.match(csv, /\r\n/);
});

test("export document keeps history pages and order payloads", () => {
  const doc = protocol.buildExport(
    [{ orderId: "1", summaries: [] }],
    [{ cursorKey: "__first__", response: { data: { marker: true } } }],
  );
  assert.equal(doc.source, "https://www.walmart.com/orders");
  assert.equal(doc.orderCount, 1);
  assert.equal(doc.historyPages[0].data.marker, true);
  assert.equal(doc.orders[0].orderId, "1");
});

test("collection walks every page, then detail and ledger, and can resume", async () => {
  const calls = [];
  const events = [];
  const pages = {
    "": { data: { orderHistoryV2: { pageInfo: { nextPageCursor: "p2" }, orderGroups: [
      { type: "IN_STORE", orderId: "111", groupId: "0", items: [{ name: "Milk", quantity: 1 }] },
    ] } } },
    p2: { data: { orderHistoryV2: { pageInfo: { nextPageCursor: null }, orderGroups: [
      { type: "GLASS", orderId: "222", groupId: "3", items: [{ name: "Bread", quantity: 1 }] },
    ] } } },
  };
  await protocol.collectAccount({
    cursor: "",
    historyDone: false,
    options: { details: true, ledger: true },
    detailQueue: [],
    ledgerQueue: [{ orderId: "111" }],
    haveDetailIds: ["111"],
    haveLedgerIds: [],
    historyTemplate: null,
    orderTemplate: null,
    ledgerTemplate: null,
    limit: 20,
    safetyPages: 10,
  }, {
    request: async (kind, attempts, item) => {
      calls.push(kind + ":" + (item?.orderId || item?.cursor || ""));
      if (kind === "history") return { json: pages[item.cursor] };
      if (kind === "detail" && item.inStore === false && item.orderId === "222") {
        return { json: { data: null } };
      }
      return { json: { data: { order: { id: item.orderId || "ledger" } } } };
    },
    sleep: async () => {},
    emit: async (event) => { events.push(event.type); },
    isStopped: () => false,
  });
  assert.deepEqual(calls.filter((call) => call.startsWith("history")), ["history:", "history:p2"]);
  assert.ok(calls.includes("detail:222"));
  assert.equal(calls.filter((call) => call.startsWith("detail:111")).length, 0);
  assert.ok(calls.filter((call) => call.startsWith("detail:222")).length >= 2);
  assert.ok(calls.includes("ledger:111"));
  assert.ok(calls.includes("ledger:222"));
  assert.ok(events.includes("history-done"));
  assert.equal(events.at(-1), "done");
});

test("a repeated cursor stops the walk instead of looping", async () => {
  await assert.rejects(() => protocol.collectAccount({
    historyDone: false,
    options: { details: false, ledger: false },
    safetyPages: 5,
  }, {
    request: async () => ({ json: { data: { orderHistoryV2: { pageInfo: { nextPageCursor: "same" }, orderGroups: [{ orderId: "1", groupId: "0" }] } } } }),
    sleep: async () => {},
    emit: async () => {},
    isStopped: () => false,
  }), /repeated the same history cursor/);
});

test("safety cap pauses before the next page", async () => {
  let historyCalls = 0;
  const events = [];
  const result = await protocol.collectAccount({
    historyDone: false,
    options: { details: true, ledger: true },
    safetyPages: 1,
  }, {
    request: async (kind) => {
      if (kind !== "history") throw new Error("details should wait until history finishes");
      historyCalls += 1;
      return { json: { data: { orderHistoryV2: { pageInfo: { nextPageCursor: "more" }, orderGroups: [{ orderId: "9", groupId: "0", type: "GLASS" }] } } } };
    },
    sleep: async () => {},
    emit: async (event) => events.push(event),
    isStopped: () => false,
  });
  assert.equal(result.phase, "paused");
  assert.equal(historyCalls, 1);
  assert.equal(events.at(-1).type, "paused");
  assert.equal(events.at(-1).cursor, "more");
});

test("script urls that mention orders are searched first", () => {
  const ranked = protocol.rankScriptUrls([
    "https://i5.walmartimages.com/df/home.js",
    "https://i5.walmartimages.com/df/orders-page.js",
  ]);
  assert.equal(ranked[0], "https://i5.walmartimages.com/df/orders-page.js");
});
