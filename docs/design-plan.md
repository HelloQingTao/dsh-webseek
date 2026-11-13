# dsh-webseek 设计与施工文档

> 自研 DSH 插件。**当前形态（2026-10-25 起）**：把 DeepSeek 网页版的**分享链接**导入为正式 DSH 会话，入口在左侧栏「工作区」标题行。
> 早先形态（右栏内嵌 chat.deepseek.com 的 webview + 登录快照 + 总结接力）已废弃，原因见 §4。

## 1. 当前范围

| 能力 | 说明 | 状态 |
|---|---|---|
| 分享链接导入 | 粘贴 `https://chat.deepseek.com/share/<id>` + 选工作区 → 同名冷会话（可打开、可续聊） | 已实现 |
| 幂等 | 台账 `~/.dsh/dsh-webseek/ledger.json`，键 `share:<id>`，重复导入返回已有会话 | 已实现 |
| 内嵌网页面板 | — | **已废弃** |
| 总结接力 | — | **已废弃** |

明确不做：向网页发消息（只读）；调用模型（插件不总结、不续写）。

## 2. 架构决策

1. **取数在宿主半**：客户端直连被 CSP/代理挡住，宿主进程用 `node:https` 直连（Node 不走系统代理）。
2. **只认公开分享**：分享是公开的，**不需要登录**，因此不需要 webview、不需要登录快照、不需要快照回放。
3. **请求 URL 由固定 base 拼**：只从用户输入里取**校验过的 share id**（`^[A-Za-z0-9_-]{6,64}$`），host/path 一律不用 → 天然免疫 SSRF。
4. **先判状态再判体**：`429`（限流）/`3xx`/非 JSON/`biz_code≠0`/空内容 分开报错，前端按 code 映射文案。
5. **只取主线**：分享消息是树（重新生成=兄弟节点），网页取每个节点的第一个子节点，导入同规则。
6. **会话 id 必须 `session-<uuid>`**：DSH 的会话目录与前端导航都按这个 id 命名，裸 uuid 的会话建出来没人能打开。
7. **入口自己挂，不走槽位**：DSH 没给「工作区」标题行留插件槽（`sidebar.workspaces` 是 single 独占），所以客户端用自己的 React 根把按钮挂进那一行；**用稳定选择器**（`[data-slot="sidebar.workspaces"] [class*="_sectionHeader"]`，退路 `[data-slot="sidebar.footer.action"]`），不依赖 CSS module 哈希类名。
8. **让客户端重拉列表，而不是等刷新**：客户端的会话列表只吃宿主推的 `api-session/added`，而那个推送只在**活会话**创建时发生；只写日志文件的会话对左栏不可见（要刷新页面才认）。宿主列表本身会合并冷会话，所以导入后让客户端 `sessions.refresh()` 重拉一次即可；弹框的「打开会话」再点左栏那一行（`[data-row-key="session:<id>"]`）——比 `openSession(id)` 可靠：客户端尚未登记该会话时，后者会落到工作区的空白会话。
   - 走过弯路：曾用 `ctx.sessions.create(id, {seed})` 把导入会话变成活会话来触发推送，但那会占用同一个 id，宿主续接冷会话时 `prepare()` 撞 id → 会话变成只能读、不能聊的死会话，故放弃。
9. **一问一答在同一个 turn**：DSH 自己写的是 `turn/start → step/start → user/message → assistant/message → step/end → turn/end`；把回答单独放进另一个 turn 会被折叠逻辑丢掉（症状：只剩第一条用户消息）。

## 3. 已验证事实（实证）

### 3.1 分享接口
- `GET https://chat.deepseek.com/api/v0/share/content?share_id=<id>` → `{data:{biz_code, biz_data:{title, model_type, messages[]}}}`；**无需登录**。
- 路径出自网页版 bundle `main.d1d163b7e4.js`（内部接口，改版即可能失效）。
- 消息结构：`{message_id, parent_id, role, fragments:[{type:'REQUEST'|'RESPONSE'|'THINK', content}]}`。
- 边缘节点对**裸客户端 UA**回 HTML 错误页；带浏览器 UA（或空 UA）回 JSON。连发会 **429**（HTML 体），故必须先判状态与 content-type。

### 3.2 会话写入
- 日志格式 v4：`{type, seq, time, data}`，`seq` 从 0 连续；`user/message`/`assistant/message` 带 `surfaceOp:'append'`；结尾 `session/end-seed` + `session/title`。
- 写完要 `workspace.attachSession(sessionId)`，并 `sessionProjectionCache.coldSnapshot(header, 0, events)` 预热投影，左栏才能立刻显示。
- `sessionController.create({sessionId})` **不会收养**已存在的会话（`reusable` 要求日志里没有 `turn/start`），会另造一个空白会话 —— 不可用于「公布」导入的会话。

## 4. 为什么废弃内嵌网页

| 障碍 | 事实 |
|---|---|
| 代理出口被封 | 本机全部流量走系统代理，代理出口访问 chat.deepseek.com 被 CloudFront 403 |
| 拿不到 webview 的代理 | shell 渲染进程里 `element.session` 为 undefined，webview 由另一个 Electron 进程持有 → 无法按会话设代理/直连 |
| 只能本地反代 | 宿主起 127.0.0.1 反代，Node 直连绕过代理 —— 但页面 origin 变成 127.0.0.1 |
| 第三方登录失效 | 微信扫码等按 origin 校验回调域名，127.0.0.1 一律被拒（`redirect_uri 参数错误`），且该 appid 对任何可拼出的回调域都报错 |
| webview 尺寸坑 | `<webview>` 宿主不能改成 `display:block`（内部 iframe 失去 flex 拉伸，高度卡在 150px） |

分享链接不需要以上任何一条，所以整条内嵌链路被拆掉。

## 5. 当前已知限制

- `api/v0/share/content` 是内部接口，DeepSeek 改版即失效（有对应错误文案）。
- 分享标题可能只是默认的「Shared Conversation」。
- **导入的会话在 ACP 后端下不能就地续聊**（`ACP_BACKEND_NEW_SESSION_REQUIRED`）：ACP 只认自己创建的会话。
  原生模型后端没有这个限制；要绕开就做「接力」——新建会话，把整段导入对话作为第一条消息发进去（后端归它管）。
- 导入的会话立刻进左栏（客户端会重拉一次列表）；万一没出现，刷新页面即可。
- 同一 share 并发导入：台账先写 `state:'pending'` 占位，第二个请求会命中该键。

## 6. 施工记录

- `lib/share.js`：分享 id 校验 / 主线树 / 片段映射 / 标题兜底（纯函数，可离线单测）
- `lib/index.js`：宿主半。`/share-import`（校验→取数→判读→写会话）、`/workspaces`、`/ledger`；写会话收口在 `createImportedSession()`，台账先占位后落定
- `lib/client.js`：客户端半。左栏图标（自建 React 根 + MutationObserver 补挂）、导入弹框（自建根挂在 body 上，ESC / 焦点陷阱 / 关闭还焦点）；
  样式全部取自 DSH 的 `--dsw-*` 令牌，并兼容 dream-skin 的 `--dsh-dream-skin-modal-*` 材质令牌（没有皮肤插件时回落到主题层），因此深浅色与皮肤自动跟随；
  工作区下拉自绘为菜单（portal 到 body + fixed 定位，原生 `<select>` 无法跟主题），Esc 先关菜单再关弹框。
- 单测：`node --test test/*.test.js`（`test/share.test.js`、`test/host.test.js`）
