import { createHash } from 'node:crypto';

/** Session IDs are opaque ASCII identifiers; never stringify objects from a UI slot. */
export function isSessionId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

export const SESSION_PREFIX = 'dsh-route-v1:';

/**
 * A stable, bounded transport namespace separate from Magpie GUI's inferred DSH IDs.
 * This is a correlation identifier, not a credential or authorization mechanism.
 */
export function sessionToken(sessionId) {
  return isSessionId(sessionId)
    ? SESSION_PREFIX + createHash('sha256').update(sessionId).digest('hex')
    : undefined;
}

/** Only send transport identity to the operator's explicitly configured gateway. */
export function sameGateway(baseURL, gatewayURL) {
  try {
    const base = new URL(baseURL);
    const gateway = new URL(gatewayURL);
    const path = (value) => value.replace(/\/+$/u, '');
    return ['http:', 'https:'].includes(base.protocol)
      && !base.username && !base.password && !gateway.username && !gateway.password
      && !base.search && !gateway.search && !base.hash && !gateway.hash
      && base.origin === gateway.origin && path(base.pathname) === path(gateway.pathname);
  } catch {
    return false;
  }
}

/** Public synchronous llm-pi-ai/request-headers hook: no retaining headers, no body changes. */
export function gatewayHeaders(request, headers, gatewayURL) {
  if (!request || !sameGateway(request.baseURL, gatewayURL)) return headers;
  const token = sessionToken(request.sessionId);
  if (!token) return headers;
  // Only ordinary agent-loop calls. Compaction/title/search purposes must not replace the badge.
  if (request.purpose !== undefined && request.purpose !== '') return headers;
  // Distinct children/forks get distinct identity and intentional Magpie affinity boundaries.
  headers.set('X-Magpie-Session', token);
  return headers;
}

export function isTaggedRoute(route) {
  return route !== null && typeof route === 'object' && !Array.isArray(route)
    && route.agent === 'dsh' && typeof route.session === 'string'
    && /^dsh-route-v1:[a-f0-9]{64}$/u.test(route.session)
    && (!route.kind || route.kind === 'chat' || route.kind === 'turn');
}

/** Never promote response IDs, inherited history, plain GUI session hints, or conv to ownership. */
export function routesForSession(routes, sessionId) {
  const token = sessionToken(sessionId);
  if (!token) return [];
  return (Array.isArray(routes) ? routes : []).filter((route) => isTaggedRoute(route) && route.session === token);
}

/** Live fallback when the durable subagent catalog is unavailable. */
export function descendantsOf(sessions, rootId) {
  if (!isSessionId(rootId)) return [];
  const all = Array.isArray(sessions) ? sessions : [];
  const result = [];
  const visited = new Set([rootId]);
  let parents = [rootId];
  let depth = 0;
  while (parents.length && result.length < 200) {
    depth += 1;
    const next = [];
    for (const session of all) {
      const header = session?.header;
      if (!header || !isSessionId(session.id) || header.origin !== 'subagent'
        || !parents.includes(header.parentSession) || visited.has(session.id)) continue;
      visited.add(session.id);
      result.push({ sessionId: session.id, parentSessionId: header.parentSession, depth, label: '' });
      next.push(session.id);
      if (result.length >= 200) break;
    }
    parents = next;
  }
  return result;
}

/** Normalize subagents.listDescendants; labels never decide ownership. */
export function catalogDescendants(entries, rootId) {
  const result = [];
  const seen = new Set([rootId]);
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.kind !== 'child' || !isSessionId(entry.id) || !isSessionId(entry.parentId)
      || !seen.has(entry.parentId) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    result.push({
      sessionId: entry.id,
      parentSessionId: entry.parentId,
      depth: Number.isSafeInteger(entry.depth) ? entry.depth : 1,
      label: typeof entry.label === 'string' ? entry.label.slice(0, 160) : '',
      mode: typeof entry.mode === 'string' ? entry.mode : '',
    });
    if (result.length >= 200) break;
  }
  return result;
}
