/* Runs in the Temu page so collection uses the page's own signed-in client. */
(function () {
  if (globalThis.__TMH_HOOKED__) return;
  globalThis.__TMH_HOOKED__ = true;

  const protocol = globalThis.TMHProtocol;
  const state = { running: false, stop: false, service: null };

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function emit(payload) {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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
      window.postMessage({ source: "wmh-page", id, store: "temu", ...payload }, location.origin);
    });
  }

  function isService(value) {
    return !!value && typeof value.queryNormalOrdersV2 === "function" && typeof value.basePost === "function";
  }

  function dig(value, depth, seen) {
    if (!value || typeof value !== "object" || depth > 5 || seen.has(value)) return null;
    if (isService(value)) return value;
    if (isService(value.$service)) return value.$service;
    seen.add(value);
    for (const key of ["$service", "store", "orderStore", "props", "value", "current"]) {
      if (!value[key]) continue;
      const hit = dig(value[key], depth + 1, seen);
      if (hit) return hit;
    }
    return null;
  }

  function serviceFromFiber(fiber) {
    const bags = [fiber.memoizedProps, fiber.pendingProps, fiber.stateNode];
    for (const bag of bags) {
      const hit = dig(bag, 0, new Set());
      if (hit) return hit;
    }
    let hook = fiber.memoizedState;
    for (let guard = 0; hook && guard < 40; guard += 1) {
      const hit = dig(hook.memoizedState, 0, new Set());
      if (hit) return hit;
      hook = hook.next;
    }
    return null;
  }

  function findService() {
    if (isService(state.service)) return state.service;
    const root = document.body || document.documentElement;
    let fiber = null;
    const node = root && Object.keys(root).find((key) => key.startsWith("__reactContainer$") || key.startsWith("__reactFiber$"));
    if (node) fiber = root[node];
    if (!fiber) {
      const host = document.querySelector("[class]");
      if (host) {
        const key = Object.keys(host).find((name) => name.startsWith("__reactFiber$"));
        if (key) fiber = host[key];
      }
    }
    if (!fiber) return null;
    const stack = [fiber];
    const seen = new Set();
    let steps = 0;
    while (stack.length && steps < 12000) {
      const current = stack.pop();
      if (!current || typeof current !== "object" || seen.has(current)) continue;
      seen.add(current);
      steps += 1;
      const hit = serviceFromFiber(current);
      if (hit) {
        state.service = hit;
        return hit;
      }
      if (current.child) stack.push(current.child);
      if (current.sibling) stack.push(current.sibling);
    }
    return null;
  }

  async function ensureService() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const service = findService();
      if (service) return service;
      await sleep(400);
    }
    throw new Error("Reload https://www.temu.com/bgt_orders.html while signed in, wait until All orders is visible, then collect again.");
  }

  async function callService(kind, body) {
    const service = await ensureService();
    if (kind === "list") return service.queryNormalOrdersV2(body);
    if (kind === "returns") return service.queryReturnOrders(body);
    if (kind === "detail" && typeof service.getOrderDetail === "function") return service.getOrderDetail(body);
    if (kind === "payment" && typeof service.getPayDetail === "function") return service.getPayDetail(body);
    const url = kind === "detail"
      ? "/api/bg/aristotle/user_combine_mall_order_detail"
      : "/api/bg/aristotle/user_payment_info_detail";
    return service.basePost({ url, params: body });
  }

  async function request(kind, body) {
    let last = null;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      if (state.stop) {
        const stopped = new Error("Stopped");
        stopped.code = "stopped";
        throw stopped;
      }
      try {
        const json = await callService(kind, body);
        const verdict = protocol.classifyPayload(json);
        if (verdict.kind === "ok") return { json };
        if (verdict.kind === "auth" || verdict.kind === "blocked") {
          const error = new Error(verdict.message);
          error.code = verdict.kind;
          throw error;
        }
        last = new Error(verdict.message || "Temu request failed");
        last.code = verdict.kind;
      } catch (error) {
        if (error.code === "auth" || error.code === "blocked" || error.code === "stopped") throw error;
        last = error;
      }
      await sleep(Math.min(30000, 1500 * 2 ** (attempt - 1)));
    }
    if (kind === "detail" || kind === "payment") {
      return { json: null, soft: true, error: last?.message || "Request failed" };
    }
    throw last || new Error("Temu request failed");
  }

  async function startJob(job) {
    if (state.running) return;
    state.running = true;
    state.stop = false;
    try {
      await ensureService();
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
      if (error.code !== "stopped") await emit({ type: "error", message: error.message || String(error) });
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
      if (data.store === "walmart" || !/(^|\.)temu\.com$/.test(location.hostname)) return;
      startJob(data.job);
    }
    if (data.type === "stop") state.stop = true;
  });
})();
