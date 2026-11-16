# dsh-magpie-route

在 DSH 输入框上方常驻一条**能核验归属**的路由条：这次请求发给 magpie 的 `group/xxx` 后，实际落在哪个成员、经过哪个子分组、是**哪个 agent** 发的。

```
⑂ 实际路由 · 主 Agent   coding → deepseek-flash → ollama-cloud/deepseek-v4.1-flash:1017 · 已完成 · 200 · 3.4s
```

展开后**子 Agent 先列**（各自最近一次实际模型），主 Agent 的请求历史在下面：

```
主 Agent · 44b201fd
  17:01:07  coding → deepseek-flash → ollama-cloud/deepseek-v4.1-flash:1017   已完成 · 200 · 57s
  16:56:55  coding → gpt-sol → agentrouter/gpt-6.1-sol                        已完成 · 200 · 26s
子 Agent (3)
  子 Agent 2 · Audit main child isolation   coding → gpt-free → agentrouter/gpt-5.6-sol   已完成 · 200 · 17s
  子 Agent 3 · Trace gateway session contracts  coding → gpt-astra → agentrouter/gpt-6-astra   已完成 · 200 · 26s
```

- **展开即见子 Agent 模型**：有记录的子 Agent 直接列出（各自最近一次实际模型），没有记录的合并成一行提示，不占版面。
- **主 agent 与每个 subagent 分开**：主行只取主 agent 自己的请求，子 agent 各自一行，不会把子 agent 的响应当成主 agent 的。
- **没发过请求的会话就是空的**：不会因为别的会话/别的子 agent 在跑而变动。
- **旧记录不猜归属**：没有带显式标识的历史请求显示「暂无可核验路由」，而不是按时间或内容推测。

## 怎么归属（0.3.0）

旧版本靠 `responseId → conv` 推断，这条路是错的：`responseId` 会跨会话重复（实测主会话历史与一个子会话同时出现 `chatcmpl-102`），fork 出来的子会话还会原样继承父会话的响应；`conv` 也不是 DSH 的会话身份。两者都会把别人的路由挂到你头上。

现在改为请求侧显式标识：

1. host 半监听 DSH 公开的 `llm-pi-ai/request-headers` 瀑布；
2. 只对**精确匹配 `gatewayURL`** 的普通对话请求（不带 `purpose` 的辅助调用如压缩/标题/搜索会被跳过）写入 `X-Magpie-Session: dsh-route-v1:<sha256(sessionId)>`；
3. 读取时只认 `route.session === 本会话标识 && route.agent === 'dsh'`，不参与任何历史推断；
4. 子 agent 由 DSH 的 `subagents.listDescendants`（持久 catalog）列出，缺失时退回已加载的 live 会话，两者都只按真实 `header.parentSession` 连边。

为什么用 `dsh-route-v1:` 前缀而不是直接写 DSH session id：magpie 的控制台会对没有显式 session 的 DSH 记录**推断**一个纯 DSH id，直接复用会和那些推断值混淆。加前缀后两者永不相撞。

### 行为变化：会话粘性

`X-Magpie-Session` 是 magpie 的**一等会话标识**，不只是显示用。启用后：

- 同一 DSH 会话的多轮稳定归属同一个账号；
- 每个 subagent 因各自 session 而分开；
- 旧版本按「首个用户消息摘要」建立的 affinity **不会迁移**，启用后的第一次请求可能重新选账号/模型；magpie 侧历史用量也不回填。

这是有意的取舍，介意的话可以把 `gatewayURL` 设成一个不匹配的值来关闭注入（同时也会失去归属能力）。

## 它解决什么

magpie 的分组是嵌套的：`group/coding` 下面既有直接成员，也有子分组（比如 `coding-pool`，按 pace 排序）；再加上 `affinity`、规则、暂停窗口，最后到底落到谁身上，光看配置推不出来。DSH 只会显示你选的 `group/coding`，看不到实际执行者，更看不到并行 subagent 各自去了哪里。

## 数据从哪来

magpie web 控制台（默认 `:3430`，**不是**网关的 `:3425`）的 Routing 页读的就是 `GET /api/gateway/trace`。host 半：

1. 用 `GET /?k=<MAGPIE_WEB_KEY>` 换登录 cookie（magpie 重启换了 key 就重登一次）；
2. 带 cookie 读 trace，首次全量、之后按 `after=<seq>` 增量；
3. 只保留渲染需要的字段（不含 prompt、账号名、成本、responseId），压成「一次请求一行」。

只读：只打 `GET /api/gateway/trace`，不碰任何写接口。key 只在 host 进程里用。

### 字段口径

| 显示 | 取自 | 说明 |
| --- | --- | --- |
| 请求的组 | `model` | `group/coding` → `coding` |
| 子分组 | 该次尝试的座位（`order`/`left` 里按 `id`+`model` 匹配）对应的 `group.via` | 同名模型在不同 provider 下不会被认错 |
| 实际成员 | `tries[]` 最后一条的 provider + `served`（回执模型） | 生成中显示在途目标，标「在途目标」 |
| 完成状态 | `done` / `status` / `canceled` | 生成中 / 等待选路 / 已完成 / 失败 / 已取消 / 完成状态未知 |

刻意**不采信**顶层 `provider` 字段：分组请求里它给的是成员表里的某个 provider，实测与 `tries` 不一致。

排序按请求**开始时间**，不是最后变更时间——老请求晚完成不能抢走「最新」的位置。

## 安装

```sh
# 1) 装包（profile 自己是 pnpm workspace root，要带 -w）
dsh plugin --profile web add -w <插件目录或 github:RWDai/dsh-magpie-route>

# 2) 给 magpie web 的 key（docker logs magpie 里 ?k= 后面那串）
#    写进 ~/.dsh/.credentials.yaml 的 refs: 下
#      MAGPIE_WEB_KEY: <key>

# 3) 重启 dsh web，刷新页面
```

卸载：`dsh plugin --profile web remove dsh-magpie-route`。

## 配置

```yaml
- id: magpie-route
  config:
    baseURL: http://127.0.0.1:3430      # magpie web 控制台，不是网关
    gatewayURL: http://127.0.0.1:3425/v1 # 只向它注入会话标识的网关（精确 origin + path）
    webKeyEnv: MAGPIE_WEB_KEY
    webKey: ''                          # 直接写 key（优先级最高，不推荐）
    limit: 12
    cacheMs: 1000
    timeoutMs: 6000
    bufferSize: 500
    childrenCacheMs: 3000               # 子 agent 目录的缓存
```

## 排错

| 条上显示 | 含义 | 怎么办 |
| --- | --- | --- |
| 未配置 Magpie Web Key | `MAGPIE_WEB_KEY` 没找到 | 写进凭据 refs，或配置 `webKey` |
| Magpie 拒绝访问 | key 换了 / 拼错 | 从 `docker logs magpie` 重新取 |
| Magpie Web 登录失败 | `/?k=` 没回 cookie | 确认 `baseURL` 是 web 控制台端口 |
| 无法读取 Magpie | 容器没起 / 端口不对 | `docker ps \| grep magpie` |
| 读取路由超时 | magpie 响应慢或卡住 | 检查 magpie；超时后会重试 |
| DSH 会话未通过校验 | 从局域网打开但浏览器会话没验过 | 用带 token 的地址重新打开 DSH |
| 插件版本未同步 | 页面缓存了旧版浏览器代码 | 刷新页面 |
| 暂无可核验路由 | 本会话还没发过带标识的请求（启用前的历史不算） | 发一条消息即可 |

## 开发

零运行时依赖：host 半只用 Node 内置能力，浏览器半只 `require("react")`。

```sh
npm test    # identity + trace 纯函数 + host 端点（假 magpie）+ 浏览器半契约
```

真实浏览器验收（不启动新服务、不发 prompt）：

```sh
DSH_VERIFY_URL="<已登录的 DSH 地址>" \
PLAYWRIGHT_MODULES=<装了 playwright-core 的目录> \
node tools/verify-dock.mjs
```

`tools/` 里的两个脚本只是诊断用，不随包发布。
