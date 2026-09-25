/* Relays the page collector to the extension archive. Isolated world. */
(function () {
  if (globalThis.__WMH_BRIDGE__) return;
  globalThis.__WMH_BRIDGE__ = true;

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "wmh-page" || !data.id) return;
    const { source, ...payload } = data;
    chrome.runtime.sendMessage({ channel: "wmh", from: "page", payload }).then((response) => {
      window.postMessage({ source: "wmh-ext", type: "ack", id: data.id, ok: !!response?.ok, error: response?.error || "" }, location.origin);
    }).catch((error) => {
      window.postMessage({ source: "wmh-ext", type: "ack", id: data.id, ok: false, error: error?.message || String(error) }, location.origin);
    });
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.channel !== "wmh" || message.from !== "background") return;
    if (message.payload?.type === "ping") {
      sendResponse({ ok: true });
      return;
    }
    window.postMessage({ source: "wmh-ext", ...message.payload }, location.origin);
    sendResponse({ ok: true });
  });
})();
