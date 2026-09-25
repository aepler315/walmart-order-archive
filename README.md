# Order History

Chrome extension with two modes. Walmart reads the signed-in account on [walmart.com/orders](https://www.walmart.com/orders). Temu reads the signed-in account on [temu.com/bgt_orders.html](https://www.temu.com/bgt_orders.html). Each mode keeps its own archive in this browser.

It uses the same purchase-history, order-detail, and payment-ledger requests the orders page uses. The browser sends your existing Walmart session. The extension does not read, copy, or store cookies, and it does not send orders anywhere else.

Date filters and search boxes left on the orders page are cleared when collection starts, so the archive is the account history rather than the current on-screen filter.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked** and select this folder: `C:\Users\aeple\Development\walmart-order`.
4. Sign in at [https://www.walmart.com/orders](https://www.walmart.com/orders) and wait until the order list is visible.
5. Click the extension icon and choose **Temu** or **Walmart** at the top. Temu collection runs only in a tab open to the Temu orders page. It stops a Walmart collection that is still running.

If the orders tab was already open when you installed the extension, reload it once so the collector can see Walmart's live requests. Walmart rotates those query ids; a reload is how the extension picks up the current ones.

## What you get

- **JSON** — every history page Walmart returned, plus the raw detail and payment-ledger payload for each order.
- **CSV** — one row per item (order id, dates, status, store, qty, price, tax, total, payment, tracking).
- **Archive page** — search and expand orders already saved in this browser.

Files download only when you click Download. The working copy stays in the extension's local database until you clear it.

Collection walks the history one page at a time, then each order, with a pause between requests. A long account can take a while. Closing the popup does not stop it. **Stop** keeps whatever is already saved, and **Continue archive** picks up from the last page.

Payment ledger calls are slower and sometimes missing for in-store tickets. Those orders are still kept. If Walmart answers with a bot check, collection stops, the saved orders stay, and you can continue after reloading the orders page.

## Temu

Open [https://www.temu.com/bgt_orders.html](https://www.temu.com/bgt_orders.html) while signed in and wait until All orders is on screen. Reload that tab once after installing or updating the extension.

Temu mode asks the orders page's own client for the account list (`type: all`, every page), then each order's detail and payment payload, then the returns list. The browser session stays in the page. The extension does not read, copy, or store cookies. A verification check stops the run and keeps the pages already saved. Continue after the orders page loads normally again.

The Temu archive is separate from the Walmart archive. Download JSON or CSV from the popup while a Temu tab is active, or open the archive page from that popup. Clearing one does not clear the other.

## Test

```powershell
npm test
```
