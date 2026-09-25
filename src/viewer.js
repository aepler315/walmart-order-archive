const summaryEl = document.querySelector("#summary");
const listEl = document.querySelector("#list");
const searchEl = document.querySelector("#search");
const moreBtn = document.querySelector("#more");
const PAGE = 40;
const store = new URLSearchParams(location.search).get("store") === "temu" ? "temu" : "walmart";
const db = store === "temu" ? TMHDB : WMHDB;
let orders = [];
let shown = PAGE;

if (store === "temu") {
  document.title = "Temu order archive";
  document.querySelector("h1").textContent = "Temu order archive";
}

function orderText(record) {
  const items = lineItems(record);
  const seller = (record.summaries || []).map((group) => group.store?.name || group.mallName || "").join(" ");
  return [record.orderId, recordStatus(record), seller, ...items.map((item) => item.name)].join(" ").toLowerCase();
}

function lineItems(record) {
  if (store === "temu") {
    return TMHProtocol.findGoods(record).map((item) => ({
      name: item.name,
      quantity: item.quantity,
      linePrice: item.price,
      itemId: item.sku,
    }));
  }
  return WMHProtocol.findLineItems(record.detailResponse || record.summaries || []);
}

function recordStatus(record) {
  if (store === "temu") return TMHProtocol.statusText(record);
  return (record.summaries || []).map(WMHProtocol.statusText).filter(Boolean).join(" · ");
}

function recordTitle(record) {
  if (store === "temu") return TMHProtocol.orderDate(record) || record.orderId;
  return record.summaries?.[0]?.title || record.summaries?.[0]?.orderDate || record.orderId;
}

function money(record) {
  if (store === "temu") return TMHProtocol.orderTotal(record);

  let total = "";
  WMHProtocol.walk(record.detailResponse, (obj) => {
    if (!total && obj.grandTotal) {
      const value = obj.grandTotal.value ?? obj.grandTotal.displayValue ?? "";
      total = value === "" ? "" : String(value);
    }
  });
  return total;
}

function render() {
  const query = searchEl.value.trim().toLowerCase();
  const matched = query ? orders.filter((order) => orderText(order).includes(query)) : orders;
  summaryEl.textContent = `${orders.length} orders in this browser. Showing ${Math.min(shown, matched.length)} of ${matched.length}${query ? " matches" : ""}.`;
  const slice = matched.slice(0, shown);
  listEl.replaceChildren();
  if (!orders.length) {
    listEl.textContent = store === "temu"
      ? "No orders saved yet. Use the extension on temu.com/bgt_orders.html."
      : "No orders saved yet. Use the extension on walmart.com/orders.";
    moreBtn.hidden = true;
    return;
  }
  for (const record of slice) {
    const details = document.createElement("details");
    details.className = "order";
    const summary = document.createElement("summary");
    const date = document.createElement("span");
    date.textContent = recordTitle(record);
    const status = document.createElement("span");
    status.className = "muted";
    status.textContent = recordStatus(record) || record.orderId;
    const total = document.createElement("span");
    total.className = "id";
    const amount = money(record);
    total.textContent = amount ? (amount.startsWith("$") ? amount : `$${amount}`) : "";
    summary.append(date, status, total);
    const body = document.createElement("div");
    body.className = "body";
    const items = lineItems(record);
    if (items.length) {
      const table = document.createElement("table");
      const head = document.createElement("tr");
      for (const label of ["Item", "Qty", "Price", "Id"]) {
        const cell = document.createElement("th");
        cell.textContent = label;
        head.append(cell);
      }
      table.append(head);
      for (const item of items) {
        const row = document.createElement("tr");
        for (const value of [item.name, item.quantity, item.linePrice, item.itemId]) {
          const cell = document.createElement("td");
          cell.textContent = value == null ? "" : String(value);
          row.append(cell);
        }
        table.append(row);
      }
      body.append(table);
    }
    if (record.detailError) {
      const note = document.createElement("p");
      note.className = "muted";
      note.textContent = record.detailError;
      body.append(note);
    }
    const raw = document.createElement("details");
    const rawSummary = document.createElement("summary");
    rawSummary.textContent = "Raw order data";
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify({
      summaries: record.summaries,
      detailResponse: record.detailResponse,
      ledgerResponse: record.ledgerResponse,
      detailError: record.detailError,
      ledgerError: record.ledgerError,
    }, null, 2);
    raw.append(rawSummary, pre);
    body.append(raw);
    details.append(summary, body);
    listEl.append(details);
  }
  moreBtn.hidden = shown >= matched.length;
}

searchEl.addEventListener("input", () => {
  shown = PAGE;
  render();
});
moreBtn.addEventListener("click", () => {
  shown += PAGE;
  render();
});
document.querySelector("#json").addEventListener("click", () => WMHDownload.downloadArchive("json", store));
document.querySelector("#csv").addEventListener("click", () => WMHDownload.downloadArchive("csv", store));

db.listOrders().then((rows) => {
  orders = rows;
  render();
}).catch((error) => {
  summaryEl.textContent = error?.message || "Could not read the local archive.";
});
