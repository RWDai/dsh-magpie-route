/** Pure trace projection. Request identity/order and changing revision are separate. */
export function parseTime(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NaN;
  if (typeof value !== 'string' || !value) return Number.NaN;
  return Date.parse(value.replace(/\.(\d{3})\d+/u, '.$1'));
}

function statusOf(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

/** Request start order; old requests finishing late cannot replace newer requests in the badge. */
export function requestOrder(a, b) {
  const at = parseTime(a?.time);
  const bt = parseTime(b?.time);
  if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at - bt;
  if (Number.isSafeInteger(a?.id) && Number.isSafeInteger(b?.id) && a.id !== b.id) return a.id - b.id;
  return (Number(a?.seq) || 0) - (Number(b?.seq) || 0);
}

/** Match an account/key attempt to its actual provider, rather than the group's initial provider. */
export function servedOf(entry) {
  const last = (Array.isArray(entry?.tries) ? entry.tries : []).filter((item) => item && typeof item === 'object').at(-1);
  const peers = [...(Array.isArray(entry?.order) ? entry.order : []), ...(Array.isArray(entry?.left) ? entry.left : [])];
  const seat = last ? peers.find((item) => item?.id === last.id && item?.model === last.model)
    ?? peers.find((item) => item?.id === last.id) : undefined;
  const upstream = typeof seat?.provider === 'string' && seat.provider
    ? seat.provider : typeof last?.id === 'string' ? last.id : '';
  const targetModel = typeof last?.model === 'string' ? last.model : '';
  const served = typeof last?.served === 'string' && last.served
    ? last.served : typeof entry?.served === 'string' && entry.served ? entry.served : '';
  const status = statusOf(entry?.status) ?? statusOf(last?.status);
  const done = entry?.done === true || (entry?.done === undefined && (status !== undefined || last?.done === true));
  return { upstream, targetModel, served, servedConfirmed: Boolean(served), status, done,
    ms: typeof entry?.ms === 'number' ? entry.ms : typeof last?.ms === 'number' ? last.ms : undefined };
}

/** The attempt's original provider/model, not a loosely matching served alias, identifies its group. */
export function viaOf(group, model, provider, seat) {
  const members = Array.isArray(group?.members) ? group.members : [];
  const vias = Array.isArray(group?.via) ? group.via : [];
  const index = members.findIndex((member) => typeof member === 'string' && member === `${provider}/${model}`);
  if (index >= 0) return typeof vias[index] === 'string' ? vias[index] : '';
  return Array.isArray(seat?.via) ? seat.via.filter((part) => typeof part === 'string').join('>') : '';
}

export function compactRoute(entry, nowMs = Number.NaN) {
  const actual = servedOf(entry);
  const { upstream, targetModel, served, status, done } = actual;
  const last = (Array.isArray(entry?.tries) ? entry.tries : []).filter((item) => item && typeof item === 'object').at(-1);
  const seat = (Array.isArray(entry?.order) ? entry.order : []).find((item) => item?.id === last?.id && item?.model === targetModel);
  const start = parseTime(entry?.time);
  const incomplete = entry?.incomplete === true;
  const failed = status >= 400 || entry?.failed === true || (typeof entry?.error === 'string' && entry.error !== '');
  const state = incomplete ? 'unknown' : done
    ? entry?.canceled === true || status === 499 ? 'canceled' : failed ? 'failed' : 'complete'
    : last ? 'streaming' : 'routing';
  const group = entry?.group;
  return {
    id: entry?.id,
    seq: Number.isSafeInteger(entry?.seq) ? entry.seq : 0,
    time: typeof entry?.time === 'string' ? entry.time : '',
    agent: typeof entry?.agent === 'string' ? entry.agent : '',
    requested: typeof entry?.model === 'string' ? entry.model : '',
    ...actual,
    state,
    via: viaOf(group, targetModel || served, upstream, seat),
    ageMs: Number.isFinite(start) && Number.isFinite(nowMs) ? Math.max(0, nowMs - start) : undefined,
    ...(incomplete ? { incomplete: true } : {}),
    ttft: typeof entry?.ttft === 'number' ? entry.ttft : undefined,
    // Only display information needed for the dock; no keys, prompts, account identities or costs.
    group: group && typeof group === 'object' ? {
      ref: typeof group.ref === 'string' ? group.ref : '',
      name: typeof group.name === 'string' ? group.name : '',
      routing: typeof group.routing === 'string' ? group.routing : '',
    } : undefined,
    tries: (Array.isArray(entry?.tries) ? entry.tries : []).filter((item) => item && typeof item === 'object').map((item) => ({
      model: typeof item.model === 'string' ? item.model : '',
      done: item.done === true,
      status: statusOf(item.status),
      ms: typeof item.ms === 'number' ? item.ms : undefined,
    })),
    rule: entry?.rule && typeof entry.rule === 'object' ? {
      n: Number.isInteger(entry.rule.n) ? entry.rule.n : undefined,
      use: typeof entry.rule.use === 'string' ? entry.rule.use : '',
      held: entry.rule.held === true,
    } : undefined,
    affinity: entry?.affinity && typeof entry.affinity === 'object' ? {
      mode: typeof entry.affinity.mode === 'string' ? entry.affinity.mode : '',
      why: typeof entry.affinity.why === 'string' ? entry.affinity.why : '',
      kept: entry.affinity.kept === true,
    } : undefined,
  };
}

export function compactTrace(doc, limit = 12) {
  const routes = (Array.isArray(doc?.routes) ? doc.routes : []).filter((item) => item && typeof item === 'object');
  const size = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 12;
  const nowMs = parseTime(doc?.now);
  return {
    seq: Number.isSafeInteger(doc?.seq) ? doc.seq : 0,
    now: typeof doc?.now === 'string' ? doc.now : '',
    routes: routes.slice().sort(requestOrder).slice(-size).map((route) => compactRoute(route, nowMs)),
  };
}

/** Only newer revisions replace a request. Late concurrent results may not rewind status/model. */
export function mergeEntries(buffer, incoming, cap = 500) {
  const byId = new Map();
  for (const item of [...(Array.isArray(buffer) ? buffer : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const key = item.id ?? item.seq;
    if (key === undefined) continue;
    const previous = byId.get(key);
    if (!previous || (Number(item.seq) || 0) > (Number(previous.seq) || 0)) byId.set(key, item);
  }
  const size = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 500;
  return [...byId.values()].sort(requestOrder).slice(-size);
}
