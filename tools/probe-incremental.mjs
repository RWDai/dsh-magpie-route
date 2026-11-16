/**
 * 探针：验证 magpie 的 `?after=<seq>` 增量是否会把同一个请求的「完成」更新带回来。
 *
 * 只读，不写任何东西。用法：
 *   MAGPIE_WEB_KEY=<k> node probe-incremental.mjs
 */
const BASE = process.env.MAGPIE_WEB_BASE ?? 'http://127.0.0.1:3430';
const KEY = process.env.MAGPIE_WEB_KEY;
const GATEWAY = process.env.MAGPIE_GATEWAY ?? 'http://127.0.0.1:3425/v1';
const GW_KEY = process.env.MAGPIE_API_KEY;
if (!KEY || !GW_KEY) {
  console.error('需要 MAGPIE_WEB_KEY 与 MAGPIE_API_KEY');
  process.exit(1);
}

async function signIn() {
  const res = await fetch(`${BASE}/?k=${encodeURIComponent(KEY)}`, { redirect: 'manual' });
  await res.arrayBuffer();
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('no cookie');
  return cookie;
}

async function trace(cookie, after) {
  const res = await fetch(`${BASE}/api/gateway/trace?after=${after}`, { headers: { cookie } });
  if (!res.ok) throw new Error(`trace HTTP ${res.status}`);
  return res.json();
}

const cookie = await signIn();
const first = await trace(cookie, 0);
let lastSeq = first.seq;
const known = new Map();
for (const e of first.routes) known.set(e.id, e);
console.log('initial doc.seq =', first.seq, 'entries =', first.routes.length);

// 发一个流式请求，观察它在增量里怎么变
const started = Date.now();
const stream = await fetch(`${GATEWAY}/chat/completions`, {
  method: 'POST',
  headers: { authorization: `Bearer ${GW_KEY}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    model: process.env.MAGPIE_MODEL ?? 'group/coding',
    stream: true,
    messages: [{ role: 'user', content: 'count slowly from 1 to 200 with one word per line' }],
    max_tokens: 400,
  }),
});
const reader = stream.body.getReader();
const drained = (async () => {
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
    }
  } catch (error) {
    console.log('stream error:', String(error?.message ?? error));
  }
  return bytes;
})();

const pollTrace = async (label) => {
  let doc;
  try {
    doc = await trace(cookie, lastSeq);
  } catch (error) {
    console.log(label, 'trace error', String(error?.message ?? error));
    return;
  }
  const incoming = doc.routes ?? [];
  for (const e of incoming) known.set(e.id, e);
  const changed = incoming.length;
  const mine = [...known.values()].sort((a, b) => a.seq - b.seq).slice(-3);
  console.log(
    `${label} doc.seq=${doc.seq} after=${lastSeq} incoming=${changed}`,
    mine.map((e) => `id=${e.id} seq=${e.seq} status=${e.status} done=${e.done}`).join(' | '),
  );
  lastSeq = Math.max(lastSeq, doc.seq);
};

for (let i = 0; i < 8; i += 1) {
  await new Promise((r) => setTimeout(r, 1000));
  await pollTrace(`t+${String(i + 1)}s`);
}
const bytes = await drained;
console.log('stream bytes =', bytes, 'elapsed =', Date.now() - started, 'ms');
// 再补两轮，看完成态有没有补上
for (let i = 0; i < 2; i += 1) {
  await new Promise((r) => setTimeout(r, 1500));
  await pollTrace(`done+${String(i + 1)}`);
}
