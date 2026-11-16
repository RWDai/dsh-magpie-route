import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const route = (sessionId = 'main', overrides = {}) => ({ id: sessionId, sessionId, seq: 1, requested: 'group/coding', upstream: sessionId + '-provider', served: sessionId + '-model', servedConfirmed: true, state: 'complete', done: true, status: 200, ms: 3400, time: '2026-11-12T11:03:06+08:00', ...overrides });
const payload = (sessionId, overrides = {}) => ({ ok: true, sessionId, attribution: 'explicit-token', role: 'main', seq: 42, scoped: true, known: true, routes: [route(sessionId)], agents: [], ...overrides });
const tick = () => new Promise((resolve) => setImmediate(resolve));

function loadClient(fetchImpl, options = {}) {
  let record;
  const timers = new Map();
  const cleanups = [];
  const effects = [];
  const styleTags = [];
  const events = new Map();
  let nextTimer = 0;
  const React = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children }; },
    useSyncExternalStore(_subscribe, get) { return get(); },
    useEffect(callback) { if (options.runEffects) { const cleanup = callback(); if (typeof cleanup === 'function') cleanups.push(cleanup); } },
  };
  const document = {
    visibilityState: options.hidden ? 'hidden' : 'visible',
    createElement() { return { setAttribute() {}, textContent: '', remove() {} }; },
    head: { appendChild(tag) { styleTags.push(tag); } },
    addEventListener(name, callback) { events.set(name, callback); },
    removeEventListener(name) { events.delete(name); },
  };
  const sandbox = { window: { __ModuleLoader__: { load(r) { record = r; } } }, document,
    fetch: fetchImpl ?? (async () => { throw new Error('unused'); }), AbortController,
    setTimeout(callback, ms) { const id = ++nextTimer; timers.set(id, { callback, ms }); return id; },
    clearTimeout(id) { timers.delete(id); }, console,
  };
  vm.runInNewContext(source, sandbox, { filename: 'client.js' });
  assert.equal(record.id, 'dsh-magpie-route');
  const client = record.factory((name) => { assert.equal(name, 'react'); return React; });
  const box = { slot: undefined, dictionaries: undefined };
  const ctx = {
    effect(callback) { effects.push(callback); const cleanup = callback(); if (typeof cleanup === 'function') cleanups.push(cleanup); },
    locale: { register(_ns, dictionaries) { box.dictionaries = dictionaries; return () => {}; } },
    slots: { inject(_name, callback) { callback(); }, register(config, Component) { box.slot = { config, Component }; return () => {}; } },
  };
  client.apply(ctx);
  const t = (key, vars = {}) => (box.dictionaries.zh[key] ?? key).replace(/\{(\w+)\}/gu, (match, name) => Object.hasOwn(vars, name) ? String(vars[name]) : match);
  return { client, ctx, box, document, timers, styleTags, cleanups, events, t };
}

function text(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  if (typeof node.type === 'function') return text(node.type({ ...node.props, children: node.children }));
  return text(node.children);
}

function fakeFetch(calls, bySession = {}) {
  return async (url) => {
    calls.push(url);
    const id = new URL(url, 'http://localhost').searchParams.get('session');
    return { ok: true, json: async () => bySession[id] ?? payload(id, { known: false, routes: [] }) };
  };
}

test('module contract, namespaced slot identity and dictionary keys are valid', () => {
  const { client, box, styleTags } = loadClient();
  assert.deepEqual(Array.from(client.inject), ['slots', 'locale']);
  assert.equal(box.slot.config.name, 'conversation.input.dock');
  assert.equal(box.slot.config.inject('main').routeSessionId, 'main');
  assert.equal(box.slot.config.inject('main').session, undefined);
  assert.deepEqual(Object.keys(box.dictionaries.zh).sort(), Object.keys(box.dictionaries.en).sort());
  assert.match(styleTags[0].textContent, /magpieRoute_root/u);
});

test('real DSH reserved session object cannot replace namespaced identity', async () => {
  const calls = [];
  const { client, box, t } = loadClient(fakeFetch(calls), { runEffects: true });
  client.RouteDock({ ...box.slot.config.inject('main'), session: { projections: {} }, t });
  await tick();
  assert.match(calls[0], /session=main/u);
  assert.doesNotMatch(calls[0], /object/u);
});

test('two simultaneously mounted session stores retain separate routes', async () => {
  const calls = [];
  const { client, t } = loadClient(fakeFetch(calls, { a: payload('a'), b: payload('b') }));
  client.mountSession('a'); client.mountSession('b');
  await tick();
  assert.match(text(client.RouteDock({ t, routeSessionId: 'a' })), /a-provider\/a-model/u);
  assert.doesNotMatch(text(client.RouteDock({ t, routeSessionId: 'a' })), /b-provider/u);
  assert.match(text(client.RouteDock({ t, routeSessionId: 'b' })), /b-provider\/b-model/u);
});

test('zero-request session stays empty while other agent routes change', async () => {
  const bySession = { main: payload('main'), empty: payload('empty', { known: false, routes: [] }) };
  const { client, t } = loadClient(fakeFetch([], bySession));
  client.mountSession('main'); client.mountSession('empty'); await tick();
  const before = text(client.RouteDock({ t, routeSessionId: 'empty' }));
  bySession.main = payload('main', { routes: [route('main', { served: 'different-model' })] });
  await client.refreshSession('main'); await client.refreshSession('empty');
  assert.equal(text(client.RouteDock({ t, routeSessionId: 'empty' })), before);
  assert.doesNotMatch(before, /main-provider|different-model/u);
});

test('new session render never uses the previous session snapshot even before effects run', async () => {
  const { client, t } = loadClient(fakeFetch([], { a: payload('a') }));
  client.mountSession('a'); await tick();
  assert.doesNotMatch(text(client.RouteDock({ t, routeSessionId: 'new' })), /a-provider/u);
});

test('late response after unmount cannot overwrite a remounted same-session result', async () => {
  let release;
  const first = new Promise((resolve) => { release = resolve; });
  let count = 0;
  const { client } = loadClient(async () => {
    count += 1;
    const mine = count;
    if (mine === 1) await first;
    return { ok: true, json: async () => payload('main', { routes: [route('main', { served: mine === 1 ? 'old' : 'new' })] }) };
  });
  const off = client.mountSession('main'); await tick(); off();
  client.mountSession('main'); await tick();
  release(); await tick();
  assert.equal(client.getSessionStore('main').get().payload.routes[0].served, 'new');
});

test('wrong-session and old-host unscoped payloads fail closed', async () => {
  for (const data of [payload('other'), { ok: true, routes: [route('main')] }, payload('main', { attribution: 'inferred-conv' })]) {
    const { client } = loadClient(async () => ({ ok: true, json: async () => data }));
    client.mountSession('main'); await tick();
    assert.equal(client.getSessionStore('main').get().error, 'version');
    assert.equal(client.getSessionStore('main').get().payload, undefined);
  }
});

test('child updates never replace the main summary, and expansion separates children', async () => {
  const bySession = { main: payload('main', { agents: [{ sessionId: 'child', label: 'Audit', depth: 1, role: 'subagent', routes: [route('child')] }] }) };
  const { client, t } = loadClient(fakeFetch([], bySession));
  client.mountSession('main'); await tick();
  const before = text(client.RouteDock({ t, routeSessionId: 'main' }));
  assert.match(before, /主 Agent/u);
  assert.doesNotMatch(before, /child-provider/u);
  bySession.main.agents[0].routes = [route('child', { served: 'changed-child-model' })];
  await client.refreshSession('main');
  assert.equal(text(client.RouteDock({ t, routeSessionId: 'main' })), before);
  client.getSessionStore('main').patch({ expanded: true });
  const expanded = text(client.RouteDock({ t, routeSessionId: 'main' }));
  assert.match(expanded, /子 Agent 1 · Audit/u);
  assert.match(expanded, /changed-child-model/u);
});

test('current pending target is distinct from the last completed request', async () => {
  const routes = [route('main'), route('main', { id: 'next', done: false, state: 'streaming', status: undefined, served: '', servedConfirmed: false, targetModel: 'pending-model' })];
  const { client, t } = loadClient(fakeFetch([], { main: payload('main', { routes }) }));
  client.mountSession('main'); await tick();
  const value = text(client.RouteDock({ t, routeSessionId: 'main' }));
  assert.match(value, /pending-model.*在途目标.*生成中/u);
});

test('old global seq cannot freeze changes; browser does not send since', async () => {
  const calls = [];
  const { client } = loadClient(fakeFetch(calls, { main: payload('main') }));
  client.mountSession('main'); await tick(); await client.refreshSession('main');
  assert.ok(calls.length >= 2);
  assert.ok(calls.every((url) => !url.includes('since=')));
});

test('hidden tabs stop work and resume their own store, not another session', async () => {
  const calls = [];
  const { client, events, document } = loadClient(fakeFetch(calls), { hidden: true });
  client.mountSession('main'); await tick(); assert.equal(calls.length, 0);
  document.visibilityState = 'visible'; events.get('visibilitychange')(); await tick();
  assert.match(calls[0], /session=main/u);
});

test('HTTP authorization failure is not mislabeled as no request', async () => {
  const { client, t } = loadClient(async () => ({ ok: false, status: 401 }));
  client.mountSession('main'); await tick();
  assert.match(text(client.RouteDock({ t, routeSessionId: 'main' })), /未通过校验/u);
});

test('client timeout releases inflight lock so the next poll retries', async () => {
  let count = 0;
  const { client, timers } = loadClient((_url, options) => {
    count += 1;
    if (count > 1) return Promise.resolve({ ok: true, json: async () => payload('main') });
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  });
  client.mountSession('main'); await tick();
  const timeout = [...timers.values()].find((entry) => entry.ms === 12000);
  timeout.callback(); await tick();
  assert.equal(client.getSessionStore('main').get().error, 'timeout');
  await client.refreshSession('main');
  assert.equal(client.getSessionStore('main').get().status, 'ready');
});
