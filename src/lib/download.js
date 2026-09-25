/* Local file download from an extension page. */
(function (root) {
  function downloadText(filename, text, type) {
    const blob = new Blob([text], { type: type || "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }

  async function downloadArchive(kind, store) {
    const temu = store === "temu";
    const db = temu ? TMHDB : WMHDB;
    const protocol = temu ? TMHProtocol : WMHProtocol;
    const orders = await db.listOrders();
    const pages = await db.listPages();
    const stamp = protocol.fileStamp();
    const prefix = temu ? "temu-order-history" : "walmart-order-history";
    if (kind === "csv") {
      downloadText(`${prefix}-${stamp}.csv`, protocol.ordersToCsv(orders), "text/csv;charset=utf-8");
      return orders.length;
    }
    const payload = protocol.buildExport(orders, pages);
    downloadText(`${prefix}-${stamp}.json`, JSON.stringify(payload), "application/json");
    return orders.length;
  }

  root.WMHDownload = { downloadText, downloadArchive };
})(globalThis);
