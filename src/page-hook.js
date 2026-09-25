/* Runs in the Walmart page so the signed-in browser session is used as-is. */
(function () {
  if (globalThis.__WMH_HOOKED__) return;
  globalThis.__WMH_HOOKED__ = true;

  const protocol = globalThis.WMHProtocol;
  const state = {
    ops: {},
    platformVersion: "",
    running: false,
    stop: false,
  };

  function remember(spec, headerVersion) {
    if (!spec?.operation || !spec.hash) return;
    const current = state.ops[spec.operation] || { hashes: [], variables: null, method: spec.method, prefix: spec.prefix, endpoint: spec.endpoint || "" };
    if (!current.hashes.includes(spec.hash)) current.hashes.unshift(spec.hash);
    if (spec.variables) current.variables = spec.variables;
    if (spec.prefix) current.prefix = spec.prefix;
    if (spec.endpoint) current.endpoint = spec.endpoint;
    if (spec.method) current.method = spec.method;
    state.ops[spec.operation] = current;
    if (headerVersion) state.platformVersion = headerVersion;
  }

  function headerValue(headers, name) {
    if (!headers) return "";
    if (typeof headers.get === "function") return headers.get(name) || headers.get(name.toLowerCase()) || "";
    const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase());
    return key ? headers[key] : "";
  }

  function noteRequest(url, init) {
    const fromUrl = protocol.parseOperationUrl(url);
    if (fromUrl) remember(fromUrl, headerValue(init?.headers, "x-o-platform-version"));
    let body = init?.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        body = null;
      }
    }
    const fromPost = protocol.parsePersistedPost(url, body);
    if (fromPost) remember(fromPost, headerValue(init?.headers, "x-o-platform-version"));
  }

  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
      noteRequest(url, init || (input instanceof Request ? input : undefined));
    } catch {
      /* observation must not break the page */
    }
    return originalFetch.apply(this, arguments);
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      this.__wmhUrl = url;
      noteRequest(url, null);
    } catch {
      /* observation must not break the page */
    }
    return originalOpen.apply(this, arguments);
  };

  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (body) {
    try {
      if (typeof body === "string" && this.__wmhUrl) noteRequest(this.__wmhUrl, { body });
    } catch {
      /* observation must not break the page */
    }
    return originalSend.apply(this, arguments);
  };

  function harvest() {
    performance.getEntriesByType("resource").forEach((entry) => noteRequest(entry.name, null));
    const inline = `${document.documentElement?.innerHTML || ""}\n${[...document.scripts].map((script) => script.textContent || "").join("\n")}`;
    absorbText(inline);
  }

  function absorbText(text) {
    const found = protocol.discoverFromText(text);
    if (found.platformVersion && !state.platformVersion) state.platformVersion = found.platformVersion;
    for (const [operation, hashes] of Object.entries(found.hashes)) {
      const spec = state.ops[operation] || { hashes: [], variables: null, method: "GET", prefix: protocol.DEFAULTS[operation]?.prefix || "", endpoint: "" };
      for (const hash of hashes) {
        if (!spec.hashes.includes(hash)) spec.hashes.push(hash);
      }
      state.ops[operation] = spec;
    }
  }

  async function discoverBundles() {
    const urls = protocol.rankScriptUrls([...document.scripts].map((script) => script.src).filter(Boolean));
    for (const url of urls) {
      if (state.ops.PurchaseHistoryV2?.hashes?.length && state.ops.getOrder?.hashes?.length) return;
      try {
        const response = await originalFetch(url, { credentials: "include" });
        if (!response.ok) continue;
        const text = await response.text();
        if (text.length > 2_500_000) continue;
        absorbText(text);
      } catch {
        /* a missing chunk just means we try the next one */
      }
    }
  }

  function randomId() {
    if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function traceparent() {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
    return `00-${hex.slice(0, 32)}-${hex.slice(32, 48)}-01`;
  }

  function emit(payload) {
    const id = randomId();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        window.removeEventListener("message", onMessage);
        resolve({ ok: false, error: "The archive did not acknowledge a page in time." });
      }, 60000);
      function onMessage(event) {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.source !== "wmh-ext" || data.type !== "ack" || data.id !== id) return;
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        resolve(data);
      }
      window.addEventListener("message", onMessage);
      window.postMessage({ source: "wmh-page", id, ...payload }, location.origin);
    });
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function endpointFor(operation, hash) {
    const spec = state.ops[operation] || {};
    const prefix = spec.prefix || protocol.DEFAULTS[operation]?.prefix;
    if (!prefix) throw new Error(`No Walmart endpoint is known for ${operation}. Reload the orders page and try again.`);
    return new URL(`https://www.walmart.com${prefix}${hash}`);
  }

  async function callOnce(operation, hash, variables) {
    const spec = state.ops[operation] || {};
    const correlation = randomId();
    const pageUrl = operation === "PurchaseHistoryV2" ? "https://www.walmart.com/orders" : `https://www.walmart.com/orders/${encodeURIComponent(variables.orderId || "")}`;
    const headers = {
      accept: "application/json",
      "content-type": "application/json",
      "x-apollo-operation-name": operation,
      "x-o-gql-query": `query ${operation}`,
      "x-o-platform": "rweb",
      "x-o-bu": "WALMART-US",
      "x-o-mart": "B2C",
      "x-o-segment": "oaoh",
      "x-o-ccm": "server",
      "x-o-correlation-id": correlation,
      "wm_qos.correlation_id": correlation,
      wm_mp: "true",
      wm_page_url: pageUrl,
      "x-enable-server-timing": "1",
      "x-latency-trace": "1",
      traceparent: traceparent(),
    };
    if (state.platformVersion) headers["x-o-platform-version"] = state.platformVersion;
    const init = { method: "GET", credentials: "include", headers, referrer: pageUrl };
    let url;
    if (spec.method === "POST" && spec.endpoint) {
      init.method = "POST";
      init.body = JSON.stringify({
        operationName: operation,
        variables,
        extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
      });
      url = spec.endpoint;
    } else {
      const built = endpointFor(operation, hash);
      built.searchParams.set("variables", JSON.stringify(variables));
      url = built.toString();
    }
    const response = await originalFetch(url, init);
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, json, text };
  }

  async function request(kind, attempts) {
    const operation = kind === "history" ? "PurchaseHistoryV2" : kind === "detail" ? "getOrder" : "getOrderLedger";
    const captured = state.ops[operation]?.hashes?.[0] || "";
    const hashes = protocol.hashesToTry(operation, captured, state.ops[operation]?.hashes || []);
    if (!hashes.length) {
      const error = new Error(`Could not find Walmart's ${operation} query. Reload https://www.walmart.com/orders and wait for the list to appear.`);
      error.code = "fail";
      throw error;
    }
    let last = null;
    for (const hash of hashes) {
      for (let variant = 0; variant < attempts.length; variant += 1) {
        let retry = 0;
        while (!state.stop) {
          const result = await callOnce(operation, hash, attempts[variant]);
          const outcome = protocol.classifyResponse(result.status, result.json, result.text);
          if (outcome.kind === "ok") return { ok: true, json: result.json, soft: false, error: "" };
          if (outcome.kind === "blocked" || outcome.kind === "auth") {
            const error = new Error(outcome.message);
            error.code = outcome.kind;
            throw error;
          }
          if (outcome.kind === "retry" && retry < 4) {
            retry += 1;
            await sleep(protocol.backoffMs(retry));
            continue;
          }
          last = { outcome, json: result.json };
          break;
        }
        if (state.stop) {
          const error = new Error("Stopped. Saved orders are kept.");
          error.code = "stopped";
          throw error;
        }
        if (last?.outcome?.kind === "variables") continue;
        break;
      }
      if (last?.outcome?.kind === "miss") continue;
      break;
    }
    if (kind === "ledger" && last?.outcome?.kind === "fail") {
      return { ok: true, json: last.json, soft: true, error: last.outcome.message };
    }
    const error = new Error(last?.outcome?.message || `Could not fetch ${operation}. Reload the orders page and continue.`);
    error.code = last?.outcome?.kind || "fail";
    throw error;
  }

  async function startJob(job) {
    if (state.running) return;
    state.running = true;
    state.stop = false;
    try {
      harvest();
      if (!state.ops.PurchaseHistoryV2?.hashes?.length || !state.ops.getOrder?.hashes?.length) await discoverBundles();
      job.historyTemplate = state.ops.PurchaseHistoryV2?.variables || null;
      job.orderTemplate = state.ops.getOrder?.variables || null;
      job.ledgerTemplate = state.ops.getOrderLedger?.variables || null;
      await protocol.collectAccount(job, {
        request,
        sleep,
        emit: async (payload) => {
          const ack = await emit(payload);
          if (ack && ack.ok === false && payload.type !== "progress") {
            throw new Error(ack.error || "Could not save a page into the local archive.");
          }
        },
        isStopped: () => state.stop,
      });
    } catch (error) {
      if (error.code !== "stopped") {
        await emit({ type: "error", message: error.message || String(error) });
      }
    } finally {
      state.running = false;
      state.stop = false;
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "wmh-ext") return;
    if (data.type === "start" && data.job) {
      if (data.store === "temu" || !/(^|\.)walmart\.com$/.test(location.hostname)) return;
      startJob(data.job);
    }
    if (data.type === "stop") state.stop = true;
  });
})();
