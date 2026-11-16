import test from 'node:test';
import assert from 'node:assert/strict';
import { isSessionId, sessionToken, sameGateway, gatewayHeaders, routesForSession, descendantsOf, catalogDescendants } from '../lib/identity.js';

const gateway = 'http://127.0.0.1:3425/v1';
const request = (sessionId = 'main') => ({ sessionId, provider: 'magpie', model: 'group/coding', baseURL: gateway });

test('opaque string IDs are validated without coercing slot objects', () => {
  for (const value of [undefined, null, {}, '[object Object]', '', 'a\r\nb', 'a b', 'a'.repeat(129)]) assert.equal(isSessionId(value), false);
  assert.equal(isSessionId('session-a:b_12.3'), true);
});

test('stable namespaced tokens do not equal GUI-inferred DSH IDs', () => {
  assert.match(sessionToken('main'), /^dsh-route-v1:[a-f0-9]{64}$/u);
  assert.equal(sessionToken('main'), sessionToken('main'));
  assert.notEqual(sessionToken('main'), sessionToken('child'));
  assert.notEqual(sessionToken('main'), 'main');
  assert.equal(sessionToken('a'.repeat(128)).length, 77);
  assert.equal(sessionToken({}), undefined);
});

test('gateway allowlist compares origin and normalized path and rejects credentials', () => {
  assert.equal(sameGateway(gateway + '/', gateway), true);
  for (const base of ['http://127.0.0.1:3426/v1', 'http://api.example/v1', gateway + '/other', gateway + '?key=x', 'http://key@127.0.0.1:3425/v1', 'not-url']) {
    assert.equal(sameGateway(base, gateway), false);
  }
});

test('child header overrides copied parent identity and leaves authentication unchanged', () => {
  const headers = new Headers({ authorization: 'Bearer test-only', 'X-Magpie-Session': sessionToken('main'), 'x-other': 'preserved' });
  assert.equal(gatewayHeaders(request('child'), headers, gateway), headers);
  assert.equal(headers.get('X-Magpie-Session'), sessionToken('child'));
  assert.equal(headers.get('authorization'), 'Bearer test-only');
  assert.equal(headers.get('x-other'), 'preserved');
});

test('auxiliary purposes and unrelated upstreams never get a badge identity', () => {
  for (const input of [{ ...request(), purpose: 'compaction' }, { ...request(), purpose: 'session-title' }, { ...request(), baseURL: 'https://example.com/v1' }, request({})]) {
    const headers = new Headers();
    gatewayHeaders(input, headers, gateway);
    assert.equal(headers.has('X-Magpie-Session'), false);
  }
});

test('main and two children remain isolated even when conv and responseId collide', () => {
  const routes = ['main', 'child1', 'child2'].map((session, id) => ({ id, agent: 'dsh', session: sessionToken(session), conv: 'same-opening', responseId: 'chatcmpl-102' }));
  for (const [index, session] of ['main', 'child1', 'child2'].entries()) assert.deepEqual(routesForSession(routes, session).map((route) => route.id), [index]);
});

test('forks with inherited parent responses do not acquire any parent requests', () => {
  const parent = { id: 1, agent: 'dsh', session: sessionToken('parent'), conv: 'shared-prefix', responseId: 'copied-response' };
  assert.deepEqual(routesForSession([parent], 'fork-child'), []);
});

test('plain GUI hints, absent identity, non-DSH callers and classifier requests stay unassigned', () => {
  const valid = { agent: 'dsh', session: sessionToken('main') };
  for (const route of [{ ...valid, session: 'main' }, { ...valid, session: undefined }, { ...valid, agent: 'magpie' }, { ...valid, kind: 'classifier' }]) {
    assert.deepEqual(routesForSession([route], 'main'), []);
  }
});

test('loaded descendants require genuine parent links and subagent origin', () => {
  const sessions = [
    { id: 'main', header: {} },
    { id: 'child1', header: { parentSession: 'main', origin: 'subagent' } },
    { id: 'grandchild', header: { parentSession: 'child1', origin: 'subagent' } },
    { id: 'fork', header: { parentSession: 'main', isSeeded: true } },
    { id: 'unrelated', header: { parentSession: 'other', origin: 'subagent' } },
  ];
  assert.deepEqual(descendantsOf(sessions, 'main').map((entry) => [entry.sessionId, entry.depth]), [['child1', 1], ['grandchild', 2]]);
});

test('durable catalog preserves labels but rejects disconnected or repeated identities', () => {
  assert.deepEqual(catalogDescendants([
    { kind: 'child', id: 'c1', parentId: 'main', depth: 1, label: 'Audit', mode: 'continuable' },
    { kind: 'diagnostic', id: 'bad', parentId: 'main' },
    { kind: 'child', id: 'c1', parentId: 'main' },
    { kind: 'child', id: 'c2', parentId: 'c1', depth: 2 },
    { kind: 'child', id: 'alien', parentId: 'other' },
  ], 'main').map((entry) => [entry.sessionId, entry.label]), [['c1', 'Audit'], ['c2', '']]);
});
