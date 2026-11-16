import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { apply } from '../lib/index.js';
import { sessionToken } from '../lib/identity.js';

const KEY = 'test-web-key';
const gateway = 'http://127.0.0.1:3425/v1';
const route = (id, session = 'main', overrides = {}) => ({
  id, seq: id, session: sessionToken(session), agent: 'dsh', conv: 'copied-opening', responseId: 'chatcmpl-102',
  time: `2026-11-12T11:03:${String(id % 60).padStart(2, '0')}+08:00`, model: 'group/coding', done: true, status: 200, ms: 100,
  tries: [{ id: session + '-provider', model: session + '-model', served: session + '-model', done: true, status: 200, ms: 100 }],
  ...overrides,
});

async function fakeMagpie() {
  const stats = { signIns: 0, traces: 0, afters: [], seq: 42, rejectNext: 0, routes: [route(7), route(8, 'child1'), route(9, 'child2')],
    ids: undefined, raw: undefined, hold: false, waiting: undefined, entered: undefined };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') {
      if (url.searchParams.get('k') !== KEY) { res.writeHead(401); res.end('denied'); return; }
      stats.signIns += 1;
      res.writeHead(303, { location: '/', 'set-cookie': `magpie_web_test=${KEY}; Path=/; HttpOnly` }); res.end(); return;
    }
    if (url.pathname !== '/api/gateway/trace') { res.writeHead(404); res.end(); return; }
    stats.traces += 1;
    const after = Number(url.searchParams.get('after')) || 0;
    stats.afters.push(after);
    if (stats.rejectNext > 0) { stats.rejectNext -= 1; res.writeHead(401); res.end('expired'); return; }
    if (!String(req.headers.cookie).includes(`magpie_web_test=${KEY}`)) { res.writeHead(401); res.end(); return; }
    const send = () => {
      const body = stats.raw ?? JSON.stringify({ seq: stats.seq, routes: stats.routes.filter((item) => item.seq > after),
        ids: stats.ids ?? stats.routes.map((item) => item.id), now: '2026-11-12T11:05:00+08:00' });
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(body);
    };
    if (stats.hold) { stats.waiting = send; stats.entered?.(); } else send();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { stats, baseURL: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}

function fakeContext(services = {}) {
  const box = { route: undefined, events: new Map(), disposers: [] };
  const ctx = {
    logger: { warn() {} },
    get(name) {
      if (name === 'webServer') return { register(row) { box.route = row; return () => {}; } };
      return services[name];
    },
    on(event, callback) { box.events.set(event, callback); return () => box.events.delete(event); },
    effect(callback) { const disposer = callback(); if (typeof disposer === 'function') box.disposers.push(disposer); },
  };
  return { ctx, box };
}

async function call(row, { method = 'GET', url = '/plugin/magpie-route/state?session=main', remote = '127.0.0.1' } = {}) {
  const result = {};
  const res = {
    headersSent: false,
    writeHead(status, headers) { result.status = status; result.headers = headers; this.headersSent = true; },
    end(body) { result.text = body ?? ''; result.body = body ? JSON.parse(body) : undefined; },
  };
  await row.handler({ method, url, socket: { remoteAddress: remote }, headers: {} }, res);
  return result;
}

async function setup(t, services = {}, config = {}) {
  const magpie = await fakeMagpie();
  t.after(magpie.close);
  const { ctx, box } = fakeContext(services);
  apply(ctx, { baseURL: magpie.baseURL, webKey: KEY, cacheMs: 0, childrenCacheMs: 0, ...config });
  t.after(() => box.disposers.forEach((dispose) => dispose()));
  return { magpie, ctx, box };
}

const live = () => [
  { id: 'main', header: {} },
  { id: 'child1', header: { parentSession: 'main', origin: 'subagent' }, log: ['inherited-does-not-matter'] },
  { id: 'child2', header: { parentSession: 'main', origin: 'subagent' } },
  { id: 'other', header: { parentSession: 'elsewhere', origin: 'subagent' } },
];

test('host installs the public header waterfall and calls next exactly once', async (t) => {
  const { box } = await setup(t);
  const hook = box.events.get('llm-pi-ai/request-headers');
  assert.equal(typeof hook, 'function');
  const headers = new Headers({ 'X-Magpie-Session': sessionToken('main'), authorization: 'Bearer test' });
  let nextCalls = 0;
  const returned = hook(Object.freeze({ provider: 'magpie', model: 'group/coding', sessionId: 'child1', baseURL: gateway }), headers, () => { nextCalls += 1; return headers; });
  assert.equal(returned, headers);
  assert.equal(nextCalls, 1);
  assert.equal(headers.get('X-Magpie-Session'), sessionToken('child1'));
  assert.equal(headers.get('authorization'), 'Bearer test');
});

test('main and children with colliding IDs/conv are separate agent rows', async (t) => {
  const { box } = await setup(t, { sessions: { list: live } });
  const main = (await call(box.route)).body;
  assert.equal(main.attribution, 'explicit-token');
  assert.equal(main.sessionId, 'main');
  assert.equal(main.role, 'main');
  assert.deepEqual(main.routes.map((item) => item.id), [7]);
  assert.equal(main.childrenScope, 'live');
  assert.deepEqual(main.agents.map((item) => [item.sessionId, item.routes[0].id]), [['child1', 8], ['child2', 9]]);
  const child = (await call(box.route, { url: '/?session=child1' })).body;
  assert.equal(child.role, 'subagent');
  assert.deepEqual(child.routes.map((item) => item.id), [8]);
});

test('zero-request session cannot inherit parent routes or GUI-inferred plain IDs', async (t) => {
  const { box, magpie } = await setup(t, { sessions: { list: () => [{ id: 'empty', header: { parentSession: 'main', origin: 'subagent', isSeeded: true }, log: [{ responseId: 'chatcmpl-102' }] }] } });
  magpie.stats.routes.push(route(10, 'main', { session: 'empty' }));
  const empty = (await call(box.route, { url: '/?session=empty' })).body;
  assert.equal(empty.known, false);
  assert.deepEqual(empty.routes, []);
});

test('invalid and missing session IDs reject before touching Magpie', async (t) => {
  const { box, magpie } = await setup(t);
  for (const query of ['/', '/?session=', '/?session=%5Bobject%20Object%5D', '/?session=' + 'a'.repeat(129), '/?session=a%20b']) {
    assert.equal((await call(box.route, { url: query })).status, 400);
  }
  assert.equal(magpie.stats.signIns, 0);
});

test('unconfigured keys return a fixed no-key error without inference traffic', async (t) => {
  const { box, magpie } = await setup(t, {}, { webKey: '', webKeyEnv: 'NO_SUCH_TEST_MAGPIE_WEB_KEY' });
  const result = await call(box.route);
  assert.equal(result.body.code, 'no-key');
  assert.equal(magpie.stats.signIns, 0);
});

test('key priority is config, then credentials, then explicitly named environment', async (t) => {
  const { box, magpie } = await setup(t, { credentials: { resolve: async () => ({ value: 'bad-credential' }) } });
  assert.equal((await call(box.route)).body.ok, true);
  assert.equal(magpie.stats.signIns, 1);
  const fixture = await setup(t, { credentials: { resolve: async () => ({ value: KEY }) } }, { webKey: '', webKeyEnv: 'TEST_MAGPIE_KEY_PRIORITY' });
  assert.equal((await call(fixture.box.route)).body.ok, true);
});

test('an expired cookie is reauthenticated once without exposing keys', async (t) => {
  const { box, magpie } = await setup(t);
  await call(box.route);
  magpie.stats.rejectNext = 1;
  const result = await call(box.route);
  assert.equal(result.body.ok, true);
  assert.equal(magpie.stats.signIns, 2);
  assert.doesNotMatch(result.text, /test-web-key/u);
});

test('browser rejection is honored even for loopback when connection exists', async (t) => {
  const { box, magpie } = await setup(t, { connection: { requestRejection: () => 401 } });
  assert.equal((await call(box.route)).status, 401);
  assert.equal(magpie.stats.traces, 0);
});

test('non-loopback without a connection is denied; authenticated LAN requests pass', async (t) => {
  const denied = await setup(t);
  assert.equal((await call(denied.box.route, { remote: '192.168.0.9' })).status, 403);
  const allowed = await setup(t, { connection: { requestRejection: () => undefined } });
  assert.equal((await call(allowed.box.route, { remote: '192.168.0.9' })).body.ok, true);
});

test('read-only methods and HEAD response semantics', async (t) => {
  const { box } = await setup(t);
  assert.equal((await call(box.route, { method: 'POST' })).status, 405);
  const head = await call(box.route, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
  assert.ok(head.headers['content-length'] > 0);
});

test('initial full read is followed by incremental reads', async (t) => {
  const { box, magpie } = await setup(t);
  await call(box.route); await call(box.route); await call(box.route);
  assert.deepEqual(magpie.stats.afters, [0, 42, 42]);
});

test('same global seq never short-circuits a changed session/children view', async (t) => {
  let children = [];
  const { box } = await setup(t, { subagents: { listDescendants: async () => children } });
  const first = await call(box.route);
  children = [{ kind: 'child', id: 'child1', parentId: 'main', depth: 1, label: 'Audit' }];
  const second = await call(box.route, { url: '/?session=main&since=' + first.body.seq });
  assert.equal(second.body.unchanged, undefined);
  assert.equal(second.body.childrenScope, 'catalog');
  assert.equal(second.body.agents[0].label, 'Audit');
  assert.equal(second.body.agents[0].routes[0].id, 8);
});

test('new revisions merge by request identity; main never adopts child traffic', async (t) => {
  const { box, magpie } = await setup(t);
  await call(box.route);
  magpie.stats.seq = 70;
  magpie.stats.routes = [route(7, 'main', { seq: 60 }), route(8, 'child1', { seq: 70 })];
  const main = (await call(box.route)).body;
  assert.deepEqual(main.routes.map((item) => [item.id, item.seq]), [[7, 60]]);
});

test('gateway restart resets buffers instead of associating old rows with new traffic', async (t) => {
  const { box, magpie } = await setup(t);
  await call(box.route);
  magpie.stats.seq = 3;
  magpie.stats.routes = [route(2, 'main', { time: '2026-11-13T09:00:00+08:00' })];
  const main = (await call(box.route)).body;
  assert.equal(main.seq, 3);
  assert.deepEqual(main.routes.map((item) => item.id), [2]);
  assert.deepEqual(magpie.stats.afters, [0, 42, 0]);
});

test('authoritative ids mark vanished unfinished requests unknown, not eternally generating', async (t) => {
  const { box, magpie } = await setup(t);
  magpie.stats.routes = [route(10, 'main', { done: false, status: null, tries: [] })];
  await call(box.route);
  magpie.stats.ids = [];
  const result = await call(box.route);
  assert.equal(result.body.routes[0].incomplete, true);
  assert.equal(result.body.routes[0].state, 'unknown');
});

test('concurrent browser polls share one fetch, preventing stale-response rewind', async (t) => {
  const { box, magpie } = await setup(t);
  magpie.stats.hold = true;
  const entered = new Promise((resolve) => { magpie.stats.entered = resolve; });
  const main = call(box.route);
  await entered;
  const child = call(box.route, { url: '/?session=child1' });
  assert.equal(magpie.stats.traces, 1);
  magpie.stats.hold = false;
  magpie.stats.waiting();
  const [a, b] = await Promise.all([main, child]);
  assert.equal(magpie.stats.traces, 1);
  assert.deepEqual(a.body.routes.map((item) => item.id), [7]);
  assert.deepEqual(b.body.routes.map((item) => item.id), [8]);
});

test('bad upstream JSON yields a bounded fixed error, not vendor text or credentials', async (t) => {
  const { box, magpie } = await setup(t);
  magpie.stats.raw = 'test-web-key SECRET invalid JSON';
  const result = await call(box.route);
  assert.equal(result.body.code, 'invalid-response');
  assert.doesNotMatch(result.text, /SECRET|test-web-key/u);
});

test('timeout covers stalled response work and later polls can retry', async (t) => {
  const { box, magpie } = await setup(t, {}, { timeoutMs: 500 });
  magpie.stats.hold = true;
  assert.equal((await call(box.route)).body.code, 'timeout');
  magpie.stats.hold = false;
  assert.equal((await call(box.route)).body.ok, true);
});
