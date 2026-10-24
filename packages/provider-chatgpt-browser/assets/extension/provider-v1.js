/** Private provider-v1 companion transport. This never exposes its bearer to page/content code. */
export const PROVIDER_V1_PROTOCOL = "provider-v1";
export const PROVIDER_V1_VERSION = 1;

const PORT_KEY = "providerV1Port";
const TOKEN_KEY = "providerV1Token";
const INSTANCE_KEY = "providerV1ProviderInstanceId";
const RELOAD_ATTEMPT_KEY = "providerV1ExtensionReloadAttempt";

export function createProviderV1Client({ chrome, fetch: fetcher, ports, peer }) {
  let loaded = false;
  let port = null;
  let token = null;
  let providerInstanceId = null;
  // A build-mismatch reload attempt is a browser-session guard, not durable provider state.
  // `storage.local` survives a full Chromium restart and can suppress the managed host's one
  // clean relaunch for the same old>new pair. Session storage survives an MV3 worker reload (so
  // it still breaks reload loops) but clears when the browser process restarts, which is exactly
  // the convergence boundary the host relies on.
  const reloadStorage = chrome.storage.session || chrome.storage.local;

  async function load() {
    if (loaded) return;
    const stored = await chrome.storage.local.get([PORT_KEY, TOKEN_KEY, INSTANCE_KEY]);
    port = Number.isInteger(stored[PORT_KEY]) ? stored[PORT_KEY] : null;
    token = typeof stored[TOKEN_KEY] === "string" ? stored[TOKEN_KEY] : null;
    providerInstanceId = typeof stored[INSTANCE_KEY] === "string" ? stored[INSTANCE_KEY] : null;
    loaded = true;
  }

  async function requestHeaders(authenticated = false) {
    const current = await peer();
    const headers = {
      "content-type": "application/json",
      "x-provider-protocol": PROVIDER_V1_PROTOCOL,
      "x-provider-version": String(PROVIDER_V1_VERSION),
      "x-provider-browser": current.browserInstanceId,
      "x-provider-extension-version": current.extensionVersion,
      "x-provider-extension-build": current.extensionBuildId,
    };
    if (authenticated && token) headers.authorization = `Bearer ${token}`;
    return headers;
  }

  async function fetchJson(candidatePort, pathname, init = {}, timeoutMs = 10_000) {
    const controller = timeoutMs > 0 ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const { authenticated = false, ...requestInit } = init;
      const response = await fetcher(`http://127.0.0.1:${candidatePort}${pathname}`, {
        ...requestInit,
        headers: { ...(await requestHeaders(Boolean(authenticated))), ...(init.headers || {}) },
        ...(controller ? { signal: controller.signal } : {}),
      });
      let data = null;
      try {
        data = await response.json();
      } catch {
        /* Invalid JSON is a transport failure below. */
      }
      return { ok: response.ok, status: response.status, data };
    } catch {
      return { ok: false, status: 0, data: null };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function validIdentity(value) {
    return (
      value &&
      value.protocol === PROVIDER_V1_PROTOCOL &&
      value.version === PROVIDER_V1_VERSION &&
      typeof value.browserInstanceId === "string" &&
      value.browserInstanceId.length > 0 &&
      typeof value.providerInstanceId === "string" &&
      value.providerInstanceId.length > 0 &&
      typeof value.extensionVersion === "string" &&
      value.extensionVersion.length > 0 &&
      typeof value.extensionBuildId === "string" &&
      value.extensionBuildId.length > 0 &&
      typeof value.ready === "boolean" &&
      Array.isArray(value.features) &&
      value.features.every((feature) => typeof feature === "string" && feature.trim().length > 0)
    );
  }

  async function rememberIdentity(candidatePort, identity) {
    if (!validIdentity(identity)) return false;
    const current = await peer();
    if (
      identity.browserInstanceId !== current.browserInstanceId ||
      identity.extensionVersion !== current.extensionVersion ||
      identity.extensionBuildId !== current.extensionBuildId
    )
      return false;
    port = candidatePort;
    providerInstanceId = identity.providerInstanceId;
    // Identity acceptance is the bridge from /hello to /pair. Do not put a storage write in that
    // critical MV3 wake path: Chromium can suspend a cold off-screen worker while a storage write
    // is pending even though the document-start wake is still awaiting the provider handshake.
    // These two fields are only discovery hints; the authenticated token below remains the durable
    // credential. Persist the hints best-effort after accepting the exact echoed identity.
    void chrome.storage.local
      .set({ [PORT_KEY]: port, [INSTANCE_KEY]: providerInstanceId })
      .catch(() => undefined);
    void reloadStorage.remove(RELOAD_ATTEMPT_KEY).catch(() => undefined);
    return true;
  }

  async function reloadForBuildMismatch(reply) {
    const expectedBuild =
      reply?.status === 409 &&
      reply.data?.error === "extension_build_mismatch" &&
      typeof reply.data.expectedBuild === "string" &&
      /^[0-9a-f]{12}$/.test(reply.data.expectedBuild)
        ? reply.data.expectedBuild
        : null;
    if (!expectedBuild || typeof chrome.runtime?.reload !== "function") return false;
    const current = await peer();
    if (!current?.extensionBuildId || current.extensionBuildId === expectedBuild) return false;
    const attempt = `${current.extensionBuildId}>${expectedBuild}`;
    const stored = await reloadStorage.get(RELOAD_ATTEMPT_KEY);
    if (stored[RELOAD_ATTEMPT_KEY] === attempt) return false;
    await reloadStorage.set({ [RELOAD_ATTEMPT_KEY]: attempt });
    chrome.runtime.reload();
    return true;
  }

  async function discover(force = false) {
    await load();
    const candidates = [...new Set([...(force ? [] : [port]), ...ports].filter(Number.isInteger))];
    for (const candidate of candidates) {
      const reply = await fetchJson(candidate, "/provider-v1/hello", { method: "GET" }, 1200);
      if (reply.ok && (await rememberIdentity(candidate, reply.data))) return reply.data;
      if (await reloadForBuildMismatch(reply)) return null;
    }
    port = null;
    await chrome.storage.local.remove(PORT_KEY).catch(() => undefined);
    return null;
  }

  async function pair(reuse = true) {
    let identity = await discover(false);
    if (!identity || port === null) return null;
    let reply = await fetchJson(port, "/provider-v1/pair", {
      method: "POST",
      body: JSON.stringify({ reuse }),
      headers: { "content-type": "application/json" },
    });
    if (!reply.ok) {
      identity = await discover(true);
      if (!identity || port === null) return null;
      reply = await fetchJson(port, "/provider-v1/pair", {
        method: "POST",
        body: JSON.stringify({ reuse }),
        headers: { "content-type": "application/json" },
      });
    }
    if (
      !reply.ok ||
      typeof reply.data?.token !== "string" ||
      !/^[a-f0-9]{64}$/i.test(reply.data.token) ||
      !(await rememberIdentity(port, reply.data?.identity))
    )
      return null;
    token = reply.data.token;
    await chrome.storage.local.set({ [TOKEN_KEY]: token });
    return reply.data.identity;
  }

  async function clearCredential() {
    token = null;
    await chrome.storage.local.remove(TOKEN_KEY).catch(() => undefined);
  }

  async function call(envelope, { wait = false } = {}) {
    await load();
    if (!token && !(await pair(true))) return { ok: false, status: 0, data: null };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (port === null && !(await discover(true))) return { ok: false, status: 0, data: null };
      const reply = await fetchJson(
        port,
        "/provider-v1/request",
        {
          method: "POST",
          authenticated: true,
          body: JSON.stringify(envelope),
        },
        wait ? 0 : 30_000,
      );
      if (reply.ok) {
        if (
          !reply.data ||
          reply.data.protocol !== PROVIDER_V1_PROTOCOL ||
          reply.data.version !== PROVIDER_V1_VERSION ||
          reply.data.requestId !== envelope?.requestId ||
          !Object.prototype.hasOwnProperty.call(reply.data, "result")
        ) {
          return { ok: false, status: 502, data: { error: "invalid_provider_response" } };
        }
        return reply;
      }
      if (await reloadForBuildMismatch(reply)) return { ok: false, status: 409, data: reply.data };
      if (reply.status === 401) {
        await clearCredential();
        if (!(await pair(true))) return reply;
        continue;
      }
      if (reply.status === 0 && attempt === 0) {
        port = null;
        if (await discover(true)) continue;
      }
      return reply;
    }
    return { ok: false, status: 0, data: null };
  }

  async function browserCall(pathname, body) {
    await load();
    if (
      !/^\/provider-v1\/browser\/(?:status|input|events|drain|stop\/(?:redeem|ack))$/.test(pathname)
    ) {
      return { ok: false, status: 400, data: { error: "invalid_provider_browser_route" } };
    }
    if (!token && !(await pair(true))) return { ok: false, status: 0, data: null };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (port === null && !(await discover(true))) return { ok: false, status: 0, data: null };
      const reply = await fetchJson(
        port,
        pathname,
        {
          method: "POST",
          authenticated: true,
          body: JSON.stringify(body || {}),
        },
        30_000,
      );
      if (reply.ok) return reply;
      if (await reloadForBuildMismatch(reply)) return { ok: false, status: 409, data: reply.data };
      if (reply.status === 401) {
        await clearCredential();
        if (!(await pair(true))) return reply;
        continue;
      }
      if (reply.status === 0 && attempt === 0) {
        port = null;
        if (await discover(true)) continue;
      }
      return reply;
    }
    return { ok: false, status: 0, data: null };
  }

  return {
    identity: () => discover(false),
    request: (envelope) => call(envelope),
    /** Long-poll transport: reconnect reissues the caller's exact envelope/cursor unchanged. */
    replay: (envelope) => call(envelope, { wait: true }),
    browser: browserCall,
    pair,
    state: async () => {
      await load();
      return { port, paired: Boolean(token), providerInstanceId };
    },
  };
}

// The canonical service-worker entry can use this without a second bundled copy. The legacy VM
// harness intentionally strips module imports; optional global lookup leaves protocol 14 untouched.
globalThis.CLF_PROVIDER_V1 = {
  createProviderV1Client,
  protocol: PROVIDER_V1_PROTOCOL,
  version: PROVIDER_V1_VERSION,
};
