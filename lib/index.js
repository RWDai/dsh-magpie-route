/**
 * Magpie route dock host. Only explicit request-owned session tokens establish ownership.
 * No responseId/conv/history correlation: those can collide or be inherited by forks.
 * Headers use the public llm-pi-ai/request-headers seam; no adapter/fetch monkeypatching.
 * Magpie's GUI infers plain DSH session IDs, so our stable namespaced token is distinct.
 */
import { compactTrace, mergeEntries } from './trace.js';
import {
  gatewayHeaders, isSessionId, isTaggedRoute, routesForSession,
  descendantsOf, catalogDescendants,
} from './identity.js';

export const name = 'magpie-route';
export const inject = [];
export const version = '0.3.2';

const DEFAULTS = {
  baseURL: 'http://127.0.0.1:3430',
  gatewayURL: 'http://127.0.0.1:3425/v1',
  webKeyEnv: 'MAGPIE_WEB_KEY',
  webKey: '',
  path: '/plugin/magpie-route/state',
  limit: 12,
  cacheMs: 1000,
  timeoutMs: 6000,
  bufferSize: 500,
  sessionCacheSize: 200,
  childrenCacheMs: 3000,
};

function int(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.trunc(number))) : fallback;
}

function normalize(raw = {}) {
  const config = { ...DEFAULTS, ...raw };
  for (const key of ['baseURL', 'gatewayURL']) {
    const url = new URL(config[key]);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new TypeError(`magpie-route: ${key} must be an HTTP(S) URL without credentials, query or fragment`);
    }
    config[key] = url.href.replace(/\/+$/u, '');
  }
  config.limit = int(config.limit, 1, 200, DEFAULTS.limit);
  config.cacheMs = int(config.cacheMs, 0, 60_000, DEFAULTS.cacheMs);
  config.timeoutMs = int(config.timeoutMs, 500, 60_000, DEFAULTS.timeoutMs);
  config.bufferSize = int(config.bufferSize, 20, 5000, DEFAULTS.bufferSize);
  config.sessionCacheSize = int(config.sessionCacheSize, 10, 2000, DEFAULTS.sessionCacheSize);
  config.childrenCacheMs = int(config.childrenCacheMs, 0, 60_000, DEFAULTS.childrenCacheMs);
  if (typeof config.path !== 'string' || !config.path.startsWith('/')) throw new TypeError('magpie-route: invalid endpoint path');
  return config;
}

function serviceOf(ctx, key) {
  try { return typeof ctx.get === 'function' ? ctx.get(key) : ctx[key]; } catch { return undefined; }
}

function rejectionFor(ctx, req) {
  const connection = serviceOf(ctx, 'connection');
  if (typeof connection?.requestRejection === 'function') {
    try { return connection.requestRejection(req); } catch { return 403; }
  }
  // Non-Web compositions without the optional connection service remain loopback-only.
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress) ? undefined : 403;
}

async function resolveWebKey(ctx, config) {
  if (typeof config.webKey === 'string' && config.webKey.trim()) return config.webKey.trim();
  const ref = config.webKeyEnv;
  if (typeof ref !== 'string' || !ref) return undefined;
  try {
    const resolved = await serviceOf(ctx, 'credentials')?.resolve(ref);
    const value = typeof resolved === 'string' ? resolved : resolved?.value;
    if (typeof value === 'string' && value.trim()) return value.trim();
  } catch { /* Optional credential seam; environment fallback is explicit. */ }
  const environment = process.env[ref];
  return typeof environment === 'string' && environment.trim() ? environment.trim() : undefined;
}

class SourceError extends Error {
  constructor(code) { super(code); this.code = code; }
}

/** Deadline covers headers AND body consumption; responses never follow redirects. */
async function fetchRead(url, init, timeoutMs, read, signal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const response = await fetch(url, { ...init, redirect: 'manual', signal: combined });
    return await read(response);
  } catch (error) {
    if (error instanceof SourceError) throw error;
    // Never pass upstream text, credential-bearing URLs, or thrown native diagnostics to clients.
    throw new SourceError(controller.signal.aborted ? 'timeout' : 'network');
  } finally {
    clearTimeout(timeout);
  }
}

function validateDocument(doc) {
  if (!doc || !Number.isSafeInteger(doc.seq) || doc.seq < 0 || !Array.isArray(doc.routes)) throw new SourceError('invalid-response');
  if (doc.routes.length > 5000) throw new SourceError('invalid-response');
  return doc;
}

/** Drop heavy prompt/cost/account details immediately after reading. */
function retainedRoute(route) {
  const { id, seq, time, agent, session, kind, model, provider, group, rule, affinity, done, status,
    ms, ttft, served, canceled, contentAt, error, tries, order, left } = route;
  return {
    id, seq, time, agent, session, kind, model, provider, group, rule, affinity, done, status,
    ms, ttft, served, canceled, contentAt,
    // Errors are not displayed raw; just preserve the fact that one was reported.
    failed: typeof error === 'string' && error.length > 0,
    tries: Array.isArray(tries) ? tries.map(({ id, model, status, ms, served, done }) => ({ id, model, status, ms, served, done })) : [],
    order: Array.isArray(order) ? order.map(({ id, model, provider, via }) => ({ id, model, provider, via })) : [],
    left: Array.isArray(left) ? left.map(({ id, model, provider, via }) => ({ id, model, provider, via })) : [],
  };
}

function createCollector(ctx, config) {
  let cookie = '';
  let cookieKey = '';
  let buffer = [];
  let lastSeq = 0;
  let lastFetchAt = 0;
  let primed = false;
  let inflight;
  let disposed = false;
  const controller = new AbortController();
  const childCache = new Map();
  const issued = new Map();

  async function signIn(key) {
    cookie = await fetchRead(`${config.baseURL}/?k=${encodeURIComponent(key)}`, {}, config.timeoutMs, async (response) => {
      const values = response.headers.getSetCookie?.() ?? [];
      await response.arrayBuffer();
      const cookies = values.map((value) => value.split(';')[0].trim()).filter((value) => value.includes('='));
      if (response.status !== 303 || cookies.length === 0) throw new SourceError(response.status === 401 || response.status === 403 ? 'unauthorized' : 'signin');
      return cookies.join('; ');
    }, controller.signal);
    cookieKey = key;
  }

  async function readTrace(key, after) {
    if (!cookie || cookieKey !== key) await signIn(key);
    const once = () => fetchRead(`${config.baseURL}/api/gateway/trace?after=${after}`, {
      headers: { cookie, accept: 'application/json' },
    }, config.timeoutMs, async (response) => {
      if (response.status === 401 || response.status === 403) {
        await response.arrayBuffer();
        throw new SourceError('unauthorized');
      }
      if (!response.ok) {
        await response.arrayBuffer();
        throw new SourceError('network');
      }
      try { return validateDocument(await response.json()); }
      catch (error) { if (error instanceof SourceError) throw error; throw new SourceError('invalid-response'); }
    }, controller.signal);
    try { return await once(); }
    catch (error) {
      if (error.code !== 'unauthorized') throw error;
      cookie = '';
      await signIn(key);
      return await once();
    }
  }

  function absorb(doc) {
    const incoming = doc.routes.filter((route) => isTaggedRoute(route)
      && (typeof route.id === 'string' || Number.isSafeInteger(route.id))
      && Number.isSafeInteger(route.seq)).map(retainedRoute);
    buffer = mergeEntries(buffer, incoming, config.bufferSize);
    // IDs is Magpie's authoritative window inventory. A missing in-flight request has
    // gone without a recoverable completion; don't infer that from seq or elapsed age.
    if (Array.isArray(doc.ids)) {
      const present = new Set(doc.ids);
      buffer = buffer.map((route) => !present.has(route.id) && route.done !== true
        ? { ...route, incomplete: true } : route);
    }
    lastSeq = doc.seq;
    primed = true;
    lastFetchAt = Date.now();
  }

  async function refreshOnce() {
    const key = await resolveWebKey(ctx, config);
    if (!key) return { error: { ok: false, code: 'no-key', version } };
    try {
      let doc = await readTrace(key, primed ? lastSeq : 0);
      if (primed && doc.seq < lastSeq) {
        // Singleflight ensures a late concurrent reply cannot impersonate a gateway restart.
        buffer = [];
        primed = false;
        lastSeq = 0;
        doc = await readTrace(key, 0);
      }
      absorb(doc);
      return { ok: true };
    } catch (error) {
      const code = error instanceof SourceError ? error.code : 'network';
      return { error: { ok: false, code, version } };
    }
  }

  async function refresh() {
    if (disposed) return { error: { ok: false, code: 'unavailable', version } };
    if (inflight) return await inflight;
    if (primed && Date.now() - lastFetchAt < config.cacheMs) return { ok: true };
    const pending = refreshOnce();
    inflight = pending;
    try { return await pending; } finally { if (inflight === pending) inflight = undefined; }
  }

  function listLive() {
    try { return serviceOf(ctx, 'sessions')?.list?.() ?? []; } catch { return []; }
  }

  async function childrenOf(sessionId) {
    const cached = childCache.get(sessionId);
    if (cached && (cached.pending || Date.now() - cached.at < config.childrenCacheMs)) return cached.pending ? await cached.pending : cached.value;
    const pending = (async () => {
      const runtime = serviceOf(ctx, 'subagents');
      if (typeof runtime?.listDescendants === 'function') {
        try {
          const entries = await runtime.listDescendants(sessionId, AbortSignal.timeout(config.timeoutMs));
          return { scope: 'catalog', children: catalogDescendants(entries, sessionId) };
        } catch { /* No query/catalog or archived branch: explicit live-only fallback. */ }
      }
      return { scope: 'live', children: descendantsOf(listLive(), sessionId) };
    })();
    childCache.set(sessionId, { pending });
    try {
      const value = await pending;
      childCache.delete(sessionId);
      childCache.set(sessionId, { value, at: Date.now() });
      while (childCache.size > config.sessionCacheSize) childCache.delete(childCache.keys().next().value);
      return value;
    } catch {
      childCache.delete(sessionId);
      return { scope: 'live', children: [] };
    }
  }

  function markIssued(sessionId) {
    issued.delete(sessionId);
    issued.set(sessionId, Date.now());
    while (issued.size > config.sessionCacheSize) issued.delete(issued.keys().next().value);
  }

  async function payloadOf(sessionId, limit) {
    const routes = routesForSession(buffer, sessionId);
    const { scope, children } = await childrenOf(sessionId);
    const now = new Date().toISOString();
    const agents = children.map((child) => {
      const own = routesForSession(buffer, child.sessionId);
      return { ...child, role: 'subagent', known: own.length > 0, requested: issued.has(child.sessionId),
        routes: compactTrace({ now, routes: own }, limit).routes.map((route) => ({ ...route, sessionId: child.sessionId })) };
    });
    const live = listLive().find((item) => item.id === sessionId);
    return {
      ok: true, version, sessionId, attribution: 'explicit-token',
      role: live?.header?.origin === 'subagent' ? 'subagent' : 'main',
      childrenScope: scope, agents, scoped: true, known: routes.length > 0,
      requested: issued.has(sessionId), fetchedAt: now,
      ...compactTrace({ seq: lastSeq, now, routes }, limit),
      routes: compactTrace({ now, routes }, limit).routes.map((route) => ({ ...route, sessionId })),
    };
  }

  return { refresh, payloadOf, markIssued, dispose() { disposed = true; controller.abort(); childCache.clear(); issued.clear(); buffer = []; } };
}

export function apply(ctx, rawConfig) {
  const config = normalize(rawConfig);
  const collector = createCollector(ctx, config);
  const webServer = serviceOf(ctx, 'webServer');
  if (typeof webServer?.register !== 'function') return;

  if (typeof ctx.on === 'function') {
    ctx.on('llm-pi-ai/request-headers', (request, headers, next) => {
      const prior = headers.get('X-Magpie-Session');
      gatewayHeaders(request, headers, config.gatewayURL);
      if (headers.get('X-Magpie-Session') !== prior && isSessionId(request.sessionId)) collector.markIssued(request.sessionId);
      return next();
    });
  }
  ctx.effect(() => () => collector.dispose());

  function sendJson(res, status, payload, head) {
    const body = JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
    res.end(head ? undefined : body);
  }

  ctx.effect(() => webServer.register({
    kind: 'exact', path: config.path,
    handler: async (req, res) => {
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { allow: 'GET, HEAD' }); res.end(); return; }
      const head = req.method === 'HEAD';
      const rejection = rejectionFor(ctx, req);
      if (rejection !== undefined) { sendJson(res, rejection, { ok: false, code: 'forbidden', version }, head); return; }
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const sessionId = url.searchParams.get('session');
        if (!isSessionId(sessionId)) { sendJson(res, 400, { ok: false, code: 'invalid-session', version }, head); return; }
        const limit = url.searchParams.has('limit') ? int(url.searchParams.get('limit'), 1, 200, config.limit) : config.limit;
        const loaded = await collector.refresh();
        if (loaded.error) { sendJson(res, 200, { ...loaded.error, sessionId }, head); return; }
        // Global seq alone cannot validate a session view or its descendant catalog.
        sendJson(res, 200, await collector.payloadOf(sessionId, limit), head);
      } catch {
        if (!res.headersSent) sendJson(res, 500, { ok: false, code: 'internal', version }, head);
        else res.end();
      }
    },
  }));
}
