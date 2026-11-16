/** Browser peer: each dock owns a session-keyed store. No global 'last route'. */
window.__ModuleLoader__.load({
  id: 'dsh-magpie-route',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const ENDPOINT = '/plugin/magpie-route/state';
    const NS = 'magpie-route';
    const LIMIT = 12;
    const REQUEST_TIMEOUT = 12000;
    const stores = new Map();
    let disposed = false;

    const zh = {
      'title': '实际路由', 'main': '主 Agent', 'child': '子 Agent',
      'loading': '读取本会话路由…',
      'empty': '暂无可核验路由（仅显示启用标识后的请求）',
      'waiting': '等待本会话的网关记录',
      'children': '子 Agent', 'children.live': '仅已加载的子 Agent',
      'details': '展开本 Agent 的请求及子 Agent 路由',
      'streaming': '生成中', 'routing': '等待选路', 'complete': '已完成',
      'failed': '失败', 'canceled': '已取消', 'unknown': '完成状态未知',
      'target': '在途目标', 'last': '最近请求',
      'rule': '规则→{use}', 'affinity': '保持会话粘性', 'retry': '切换 ×{n}',
      'error.no-key': '未配置 Magpie Web Key', 'error.signin': 'Magpie Web 登录失败',
      'error.unauthorized': 'Magpie 拒绝访问', 'error.network': '无法读取 Magpie',
      'error.timeout': '读取路由超时', 'error.forbidden': 'DSH 会话未通过校验',
      'error.version': '插件版本未同步，请刷新页面',
      'error.invalid-session': '当前会话标识不可用', 'error.other': '路由暂不可用',
    };
    const en = {
      'title': 'Route', 'main': 'Main agent', 'child': 'Subagent',
      'loading': 'Reading this session’s routes…',
      'empty': 'No verified route (only requests sent with identity enabled)',
      'waiting': 'Waiting for this session’s gateway record',
      'children': 'Subagents', 'children.live': 'Loaded subagents only',
      'details': 'Expand this agent’s requests and subagent routes',
      'streaming': 'Generating', 'routing': 'Waiting for routing', 'complete': 'Completed',
      'failed': 'Failed', 'canceled': 'Canceled', 'unknown': 'Completion unknown',
      'target': 'In-flight target', 'last': 'Latest request',
      'rule': 'rule→{use}', 'affinity': 'session affinity', 'retry': 'switched ×{n}',
      'error.no-key': 'Magpie Web Key is not configured', 'error.signin': 'Magpie Web sign-in failed',
      'error.unauthorized': 'Magpie denied access', 'error.network': 'Cannot read Magpie',
      'error.timeout': 'Route read timed out', 'error.forbidden': 'DSH session not authenticated',
      'error.version': 'Plugin versions differ; reload the page',
      'error.invalid-session': 'Current session identity unavailable', 'error.other': 'Routes unavailable',
    };

    const CSS = `
.magpieRoute_root{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);box-shadow:var(--dsw-elevation-panel);flex:none;margin:0 auto;overflow:hidden;color:var(--dsw-alias-label-secondary);font-size:13px}
.magpieRoute_body{padding:6px 12px;display:flex;flex-direction:column;gap:8px}
.magpieRoute_header{display:flex;align-items:center;gap:10px;min-width:0;width:100%;padding:0;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.magpieRoute_header:focus-visible{outline:2px solid var(--dsw-alias-label-tertiary);outline-offset:2px;border-radius:6px}
.magpieRoute_title{flex:none;color:var(--dsw-alias-label-primary);font-weight:500;line-height:24px}
.magpieRoute_summary{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
.magpieRoute_summary b,.magpieRoute_route b{font-weight:500}
.magpieRoute_summary i,.magpieRoute_route i{font-style:normal;color:var(--dsw-alias-label-tertiary)}
.magpieRoute_detail{display:flex;flex-direction:column;gap:7px;max-height:280px;overflow-y:auto;padding-top:8px;box-shadow:inset 0 1px 0 var(--dsw-alias-border-l1);font-size:12px}
.magpieRoute_row{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:10px;align-items:baseline;line-height:19px}
.magpieRoute_route{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.magpieRoute_meta{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.magpieRoute_error{color:var(--dsw-alias-state-error-primary)}
.magpieRoute_child{padding:5px 0;display:flex;flex-wrap:wrap;gap:3px 8px;line-height:19px}
.magpieRoute_childLabel{font-weight:500;color:var(--dsw-alias-label-primary)}
.magpieRoute_chevron{flex:none;color:var(--dsw-alias-label-tertiary)}
`;

    function validSession(value) {
      return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
    }
    function errorKey(code) { return Object.hasOwn(zh, 'error.' + code) ? 'error.' + code : 'error.other'; }
    function visible() { return document.visibilityState === 'visible'; }
    function lastRoute(routes) { return Array.isArray(routes) ? routes.at(-1) : undefined; }
    function active(route) { return route && !route.incomplete && route.state !== 'complete' && route.state !== 'failed' && route.state !== 'canceled' && route.done !== true; }

    /** Request state, timers and listeners are isolated by exact session ID. */
    function getSessionStore(sessionId) {
      const key = validSession(sessionId) ? sessionId : '';
      let store = stores.get(key);
      if (store) return store;
      store = {
        sessionId: key,
        snapshot: { status: key ? 'idle' : 'error', error: key ? undefined : 'invalid-session', payload: undefined, expanded: false },
        listeners: new Set(), mounted: 0, generation: 0, timer: undefined, inflight: undefined, controller: undefined,
        get() { return store.snapshot; },
        subscribe(listener) { store.listeners.add(listener); return () => store.listeners.delete(listener); },
        patch(next) { store.snapshot = { ...store.snapshot, ...next }; for (const listener of store.listeners) listener(); },
      };
      stores.set(key, store);
      // Evict only inactive stores; mounted views must remain stable external-store sources.
      if (stores.size > 200) {
        for (const [id, item] of stores) {
          if (item !== store && item.mounted === 0 && item.listeners.size === 0) { stop(item); stores.delete(id); }
          if (stores.size <= 200) break;
        }
      }
      return store;
    }

    function stop(store) {
      clearTimeout(store.timer);
      store.generation += 1;
      store.controller?.abort();
      store.controller = undefined;
      store.inflight = undefined;
    }

    function schedule(store) {
      clearTimeout(store.timer);
      if (disposed || store.mounted === 0 || !visible()) return;
      const payload = store.snapshot.payload;
      const fast = active(lastRoute(payload?.routes)) || payload?.agents?.some((child) => active(lastRoute(child.routes)));
      store.timer = setTimeout(() => refreshSession(store.sessionId), fast ? 1200 : 2000);
    }

    async function refreshSession(sessionId) {
      const store = getSessionStore(sessionId);
      if (disposed || store.mounted === 0 || !visible() || !store.sessionId) return;
      if (store.inflight) return await store.inflight;
      const mine = ++store.generation;
      const controller = new AbortController();
      store.controller = controller;
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
      const query = `${ENDPOINT}?limit=${LIMIT}&session=${encodeURIComponent(store.sessionId)}`;
      const owns = () => !disposed && store.generation === mine && store.mounted > 0;
      const pending = (async () => {
        try {
          const response = await fetch(query, { headers: { accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
          if (!response.ok) {
            if (owns()) store.patch({ status: 'error', payload: undefined, error: [401, 403].includes(response.status) ? 'forbidden' : 'network' });
            return;
          }
          const payload = await response.json();
          if (!owns()) return;
          if (payload?.sessionId !== store.sessionId || (payload.ok && payload.attribution !== 'explicit-token')) {
            store.patch({ status: 'error', payload: undefined, error: 'version' });
            return;
          }
          store.patch({ status: payload.ok ? 'ready' : 'error', payload: payload.ok ? payload : undefined, error: payload.ok ? undefined : payload.code });
        } catch {
          if (owns()) store.patch({ status: 'error', payload: undefined, error: controller.signal.aborted ? 'timeout' : 'network' });
        } finally {
          clearTimeout(timeout);
          if (store.generation === mine) { store.controller = undefined; store.inflight = undefined; schedule(store); }
        }
      })();
      store.inflight = pending;
      await pending;
    }

    function mountSession(sessionId) {
      const store = getSessionStore(sessionId);
      store.mounted += 1;
      if (store.mounted === 1) void refreshSession(store.sessionId);
      return () => {
        store.mounted = Math.max(0, store.mounted - 1);
        if (store.mounted === 0) stop(store);
      };
    }

    function shortId(value) { return String(value || '').replace(/^session-/u, '').slice(0, 8); }
    function shortGroup(value) { return String(value || '').replace(/^group\//u, ''); }
    function modelPath(route) {
      const model = route?.served || route?.targetModel;
      return route?.upstream && model ? route.upstream + '/' + model : model || route?.upstream || '';
    }
    function duration(ms) { return typeof ms !== 'number' || ms <= 0 ? '' : ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + 's'; }
    function statusText(route, t) {
      if (!route) return '';
      const state = route.incomplete ? 'unknown' : route.state || (route.done ? 'complete' : 'streaming');
      const parts = [t(state)];
      if (typeof route.status === 'number' && route.status > 0) parts.push(String(route.status));
      if (duration(route.ms)) parts.push(duration(route.ms));
      return parts.join(' · ');
    }
    function emptyText(item, t) { return t(item?.requested ? 'waiting' : 'empty'); }
    function reasonText(route, t) {
      const parts = [];
      if (route.rule?.use) parts.push(t('rule', { use: shortGroup(route.rule.use) }));
      if (route.affinity?.kept) parts.push(t('affinity'));
      if (route.tries?.length > 1) parts.push(t('retry', { n: route.tries.length - 1 }));
      return parts.join(' · ');
    }
    function routeParts(route) {
      const nodes = [h('b', { key: 'requested' }, shortGroup(route.requested))];
      if (route.via) nodes.push(h('i', { key: 'a' }, ' → '), h('b', { key: 'via' }, route.via.replace(/>/gu, ' → ')));
      const model = modelPath(route);
      if (model) nodes.push(h('i', { key: 'b' }, ' → '), h('b', { key: 'model' }, model));
      return nodes;
    }

    function RouteDetail({ t, payload }) {
      const routes = Array.isArray(payload.routes) ? payload.routes : [];
      const children = Array.isArray(payload.agents) ? payload.agents : [];
      return h('div', { className: 'magpieRoute_detail' },
        h('div', { className: 'magpieRoute_meta' }, t(payload.role === 'subagent' ? 'child' : 'main') + ' · ' + shortId(payload.sessionId)),
        routes.length ? routes.slice().reverse().map((route) => h('div', { className: 'magpieRoute_row', key: String(route.id ?? route.seq) },
          h('span', { className: 'magpieRoute_meta' }, String(route.time || '').slice(11, 19)),
          h('span', { className: 'magpieRoute_route', title: modelPath(route) }, ...routeParts(route)),
          h('span', { className: 'magpieRoute_meta' }, statusText(route, t)))) : h('div', { className: 'magpieRoute_meta' }, emptyText(payload, t)),
        children.length ? h('div', { className: 'magpieRoute_meta' }, t(payload.childrenScope === 'live' ? 'children.live' : 'children') + ` (${children.length})`) : null,
        ...children.map((child, index) => {
          const route = lastRoute(child.routes);
          return h('div', { className: 'magpieRoute_child', key: child.sessionId, 'data-agent-session': child.sessionId, style: { paddingLeft: Math.min(4, Math.max(0, (child.depth || 1) - 1)) * 10 } },
            h('span', { className: 'magpieRoute_childLabel', title: child.sessionId }, t('child') + ' ' + (index + 1) + ' · ' + (child.label || shortId(child.sessionId))),
            h('span', { className: 'magpieRoute_route', title: route ? modelPath(route) : '' }, ...(route ? routeParts(route) : [emptyText(child, t)])),
            route ? h('span', { className: 'magpieRoute_meta' }, statusText(route, t)) : null);
        }));
    }

    function RouteDock({ t, routeSessionId }) {
      const store = getSessionStore(routeSessionId);
      const snapshot = React.useSyncExternalStore(store.subscribe, store.get, store.get);
      React.useEffect(() => mountSession(routeSessionId), [routeSessionId]);
      const payload = snapshot.payload;
      const latest = lastRoute(payload?.routes);
      const title = t('title') + ' · ' + t(payload?.role === 'subagent' ? 'child' : 'main');
      let summary;
      if (snapshot.status === 'idle') summary = t('loading');
      else if (snapshot.error) summary = t(errorKey(snapshot.error));
      else if (!latest) summary = emptyText(payload, t);
      else summary = [
        ...routeParts(latest),
        latest.servedConfirmed === false && active(latest) && modelPath(latest) ? h('i', { key: 'target' }, ' · ' + t('target')) : null,
        reasonText(latest, t) ? h('i', { key: 'why' }, ' · ' + reasonText(latest, t)) : null,
        h('i', { key: 'state' }, ' · ' + statusText(latest, t)),
      ];
      return h('div', { className: 'magpieRoute_root', 'data-magpie-route': true, 'data-route-session': store.sessionId },
        h('div', { className: 'magpieRoute_body' },
          h('button', { type: 'button', className: 'magpieRoute_header', 'aria-label': t('details'), 'aria-expanded': snapshot.expanded, onClick: () => store.patch({ expanded: !snapshot.expanded }) },
            h('span', { 'aria-hidden': 'true' }, '⑂'),
            h('span', { className: 'magpieRoute_title' }, title),
            h('span', { className: 'magpieRoute_summary' + (snapshot.error ? ' magpieRoute_error' : '') }, summary),
            h('span', { className: 'magpieRoute_chevron', 'aria-hidden': 'true' }, snapshot.expanded ? '⌃' : '⌄')),
          snapshot.expanded && payload ? h(RouteDetail, { t, payload }) : null));
    }

    function apply(ctx) {
      disposed = false;
      ctx.effect(() => {
        const style = document.createElement('style');
        style.setAttribute('data-magpie-route-style', '');
        style.textContent = CSS;
        document.head.appendChild(style);
        return () => style.remove();
      });
      ctx.effect(() => ctx.locale.register(NS, { zh, en }));
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock', id: 'magpie-route', order: 12, locale: NS,
        // 'session' is a reserved DSH prop. Do not reuse it for identity.
        inject: (sessionId) => ({ routeSessionId: sessionId }),
      }, RouteDock));
      const onVisibility = () => {
        for (const store of stores.values()) {
          if (store.mounted === 0) continue;
          if (visible()) void refreshSession(store.sessionId);
          else stop(store);
        }
      };
      document.addEventListener('visibilitychange', onVisibility);
      ctx.effect(() => () => {
        disposed = true;
        document.removeEventListener('visibilitychange', onVisibility);
        for (const store of stores.values()) stop(store);
        stores.clear();
      });
    }

    return { apply, inject: ['slots', 'locale'], RouteDock, RouteDetail, getSessionStore, mountSession, refreshSession };
  },
});
