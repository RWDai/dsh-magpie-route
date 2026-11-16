import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTime, compactRoute, compactTrace, mergeEntries, viaOf } from '../lib/trace.js';

const route = (overrides = {}) => ({
  id: 1, seq: 10, time: '2026-11-12T11:03:06.367628113+08:00', agent: 'dsh', model: 'group/coding',
  provider: 'wrong-initial-provider', done: true, status: 200, ms: 5211,
  group: { ref: 'group/coding', name: 'coding', routing: 'order', members: ['ollama-cloud/deepseek-flash', 'other/deepseek-flash'], via: ['coding-pool', 'other-pool'] },
  order: [{ id: 'account-1', model: 'deepseek-flash', provider: 'ollama-cloud', via: ['coding-pool'] }],
  tries: [{ id: 'account-1', model: 'deepseek-flash', served: 'deepseek-flash:1017', done: true, status: 200, ms: 5000 }],
  ...overrides,
});

test('attempt seat determines provider; served alias is not the originally requested member', () => {
  const compact = compactRoute(route());
  assert.equal(compact.upstream, 'ollama-cloud');
  assert.equal(compact.served, 'deepseek-flash:1017');
  assert.equal(compact.targetModel, 'deepseek-flash');
  assert.equal(compact.via, 'coding-pool');
  assert.equal(compact.ms, 5211);
});

test('identical model names on different providers do not select the wrong subgroup', () => {
  assert.equal(viaOf(route().group, 'deepseek-flash', 'other'), 'other-pool');
  assert.equal(viaOf(route().group, 'unlisted', 'other'), '');
});

test('in-flight target is shown before any completion ID or status exists', () => {
  const compact = compactRoute(route({ done: false, status: null, ms: undefined, tries: [{ id: 'account-1', model: 'deepseek-flash', done: false }] }));
  assert.equal(compact.upstream, 'ollama-cloud');
  assert.equal(compact.targetModel, 'deepseek-flash');
  assert.equal(compact.servedConfirmed, false);
  assert.equal(compact.status, undefined);
  assert.equal(compact.state, 'streaming');
});

test('failed earlier attempt never impersonates the active target', () => {
  const compact = compactRoute(route({ done: false, status: undefined, tries: [
    { id: 'a', model: 'old', status: 429, done: true }, { id: 'b', model: 'current', done: false },
  ] }));
  assert.equal(compact.upstream, 'b');
  assert.equal(compact.targetModel, 'current');
  assert.equal(compact.status, undefined);
  assert.equal(compact.state, 'streaming');
});

test('before an attempt there is waiting-for-routing, not an invented actual model', () => {
  const compact = compactRoute(route({ done: false, status: undefined, tries: [] }));
  assert.equal(compact.state, 'routing');
  assert.equal(compact.upstream, '');
  assert.equal(compact.served, '');
});

test('completion and cancellation require explicit lifecycle evidence', () => {
  assert.equal(compactRoute(route()).state, 'complete');
  assert.equal(compactRoute(route({ status: 500 })).state, 'failed');
  assert.equal(compactRoute(route({ status: 499 })).state, 'canceled');
  assert.equal(compactRoute(route({ incomplete: true, done: false, status: undefined, tries: [] })).state, 'unknown');
});

test('request start order wins over late completion revisions', () => {
  const old = route({ id: 1, seq: 30 });
  const newer = route({ id: 2, seq: 20, time: '2026-11-12T11:04:00+08:00' });
  assert.deepEqual(compactTrace({ routes: [newer, old] }).routes.map((entry) => entry.id), [1, 2]);
  assert.equal(compactTrace({ routes: [newer, old] }, 1).routes[0].id, 2);
});

test('new revision overwrites the same request without duplicate rows', () => {
  assert.deepEqual(mergeEntries([{ id: 1, seq: 1 }], [{ id: 1, seq: 5, status: 200 }]), [{ id: 1, seq: 5, status: 200 }]);
});

test('late or equal revisions cannot roll back the accepted state', () => {
  const latest = { id: 1, seq: 30, status: 200 };
  assert.deepEqual(mergeEntries([latest], [{ id: 1, seq: 20, status: null }, { id: 1, seq: 30, status: null }]), [latest]);
});

test('capacity drops old requests instead of newer requests with fewer revisions', () => {
  const entries = [route({ id: 1, seq: 100 }), route({ id: 2, seq: 50, time: '2026-11-12T11:04:00+08:00' })];
  assert.equal(mergeEntries(entries, [], 1)[0].id, 2);
});

test('invalid inputs do not grow the buffer or crash projection', () => {
  assert.deepEqual(mergeEntries([null, 'x', {}], [null, [], { id: 1, seq: 2 }]), [{ id: 1, seq: 2 }]);
  assert.deepEqual(compactTrace(undefined).routes, []);
});

test('nanosecond timestamps and numeric event times parse safely', () => {
  assert.equal(parseTime(route().time), Date.parse('2026-11-12T11:03:06.367+08:00'));
  assert.equal(parseTime(123), 123);
  assert.ok(Number.isNaN(parseTime('nope')));
  const now = '2026-11-12T11:04:06.367+08:00';
  assert.equal(compactTrace({ now, routes: [route()] }).routes[0].ageMs, 60000);
});

test('compact payload excludes raw prompts, account names, costs and response IDs', () => {
  const compact = compactRoute(route({ prompt: 'secret-text', cost: 10, responseId: 'colliding', callerKeyName: 'DSH', rule: { use: 'group/fast', held: true } }));
  for (const key of ['prompt', 'cost', 'responseId', 'order', 'callerKeyName']) assert.equal(Object.hasOwn(compact, key), false);
  assert.equal(compact.rule.use, 'group/fast');
  assert.doesNotMatch(JSON.stringify(compact), /account-1|secret-text/u);
});
