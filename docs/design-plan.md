# dsh-webseek 设计与施工文档

> 自研 DSH 插件：把 chat.deepseek.com 接入 DSH——桌面版内嵌网页面板 + 网页会话导入为正式 DSH 会话 + 总结接力开新会话。需求由用户 2026-10-23 提出，方案文档同日交付，2026-10-24 拍板开工。

## 1. 目标与范围

| 能力 | 说明 | 优先级 |
|---|---|---|
| A 内嵌面板 | 桌面版右侧栏 Tab 内嵌 chat.deepseek.com 真网页（登录一次，重启免登） | P0 |
| B1 历史导入 | 拉取网页会话列表，选中后导入为**正式 DSH 会话**（可打开、可续聊），幂等（重复导入自动跳过） | P0 |
| B2 总结接力 | 把网页会话（整段/单轮）按格式总结后**一键开正式新 DSH 会话**（不是塞输入框草稿） | P1 |
| 降级形态 | 纯 web profile（无桌面通道）：面板提示需桌面版；接力降级为系统浏览器打开 + 剪贴板接力 | P1 |

明确不做：向网页自动发送消息（只读导入，不发逆向协议请求）；把 DSH 消息回写进网页。

## 2. 核心设计决策（2026-10-23 定稿）

1. **登录态零粘贴**：桌面 guest webview 内嵌网页，userToken 从 guest 站点存储自动读，全程不让用户粘 token。
2. **只读导入**：不从插件侧向 DeepSeek 发消息。
3. **幂等键 = 网页会话 id**：导入台账 `~/.dsh/dsh-webseek/ledger.json`，重复导入跳过。
4. **接力开正式新会话**：总结由新会话内的模型完成，插件自身不调模型。
5. **桌面优先，web 降级**：iframe 被 CSP 禁死，纯 web 无内嵌能力。
6. **配置落插件独立目录**：`~/.dsh/dsh-webseek/`（session.json 登录快照、ledger.json 导入台账），不进 settings。

## 3. 已验证技术事实（2026-10-24，实证来源：asar / CLI node_modules / 参考插件源码 / 分区存储）

### 3.1 内嵌通道（桌面）
- `chat.deepseek.com` 返回 `Content-Security-Policy: frame-ancestors 'none'`，iframe 被浏览器层面拒绝；唯一正路 = 桌面 shell 的 browser guest。
- 桥：`globalThis.dshDesktop`（`protocolVersion === 1`）→ `browser.acquire(workspace)` → `{ lease, partition }`；`<webview>` 属性 `name=lease`、`partition`、`src='about:blank#<lease>'`、`useragent`（须去掉 electron token 的纯 Chrome UA）。
- **分区由 shell 每次运行新发**（`dsh-sidebar-browser-<uuid>`），插件不可指定 persist 分区 → 登录持久化必须走**快照/回放**：`executeJavaScript` 读 `localStorage` 全量 + `document.cookie` 存 `session.json`（30s 周期 + 导航时机）；回放 = 首次真实 origin 加载后 `localStorage.setItem` 恢复再导航一次。
- 快照必须加 **origin 守卫**：guest 首文档是 `about:blank#<lease>`（opaque origin，localStorage 抛异常），非 `chat.deepseek.com` 时不读不写，防空快照覆盖真快照。
- DeepSeek 凭据在 `localStorage.userToken`（bearer），HttpOnly cookie 不可恢复但无碍登录恢复。

### 3.2 DSH 侧会话写入（导入 B1）
- 事件序列：`turn/start → user/message → step/start → assistant/message → step/end → turn/end`，另加 `session/title`、`session/end-seed`。
- `sessionPersistence.create + append` 只写持久化（不进 live store）；`workspace.attachSession` 挂工作区；导入后左侧列表需刷新才可见。
- 会话事件读取走 `ctx.sessionQuery.readSession`（参考插件用于 B2 上下文提取；本插件 B2 内容来自网页侧，暂不需要）。

### 3.3 DeepSeek 网页 API（导入 B1）
- `GET /api/v0/chat_session/fetch_page?count=100`（会话目录，仅最新 100 条、无分页游标）
- `GET /api/v0/chat/history_messages`（单会话历史）
- 头 `Authorization: Bearer <userToken>`。**本插件的调用位置 = guest 页面内 executeJavaScript 同源 fetch**：自带 cookie 与登录态、token 不出 guest 不落盘（优于 host 代发/子进程方案）。

### 3.4 DSH 账号登录与网页登录的关系（用户 2026-10-24 问询的结论）
- 不能共用：DSH 账号登录的 token 发 `api.deepseek.com`（`x-dsh-auth-token`，存 `~/.dsh/.credentials.yaml`，kind: grant）；chat 网页内部接口只认网页自身 `localStorage.userToken` + 会话 cookie。两套凭据互不可换。
- App 自身用持久分区 `persist:dsh-platform-*` 承载其登录网页，但 guest 通道不暴露该能力 → 本插件采用快照方案（见 3.1）。

### 3.5 插件挂载机制
- 双面插件：host 半 `export const name/inject/apply(ctx)`，`ctx.effect(() => ctx.webServer.register({kind:'exact', path, handler}), tag)` 注册路由；client 半 `window.__ModuleLoader__.load({id, factory})`，`ctx.slots.inject('sidebar.right.pane.tab', ...)` + `ctx.sidebarRightTabs.register({id, kind, title, keepMounted: true})`。
- client 服务注入：`['slots', 'locale', 'sidebarRight', 'sidebarRightTabs']`；文案走 `ctx.locale.register(NS, {zh, en})` + `ctx.locale.bind(NS)`。
- 版本声明硬规则：`engines.dsh` 范围 `">=0.2.0-rc.2 <0.3.0"`，禁止枚举/裸 `*`。

## 4. 实施顺序（每步可单独验收）

1. **骨架内嵌** ✅ 本仓库 step 1：可安装、可挂载、右侧栏出现 Tab，状态卡显示通道可用性 → 下一步把占位 body 换成 guest 面板（step 4 的 overlay + 快照回放一并实现）。
2. **凭据 + 目录**：guest 登录后 30s 周期快照到 session.json，重启回放免登。
3. **导入**：guest 内同源拉目录/历史 → host 路由写正式会话 + ledger 幂等。
4. **接力**：范围 × 格式选择 → 开正式新会话（会话模型完成总结）。
5. **发布纪律**：敏感筛查 → 性能体检 → 相邻插件影响 → README 双语 → 本地 commit；push/tag/npm publish 等用户明示。

## 5. 验收基线

- 安装闸：`dsh plugin --profile desktop add <本地包>` 成功，boot 无 skip/did not activate。
- 挂载：预载清单含 `dsh-webseek/client.js`；浏览器 console 无新报错。
- 面板：Tab 出现、guest 显示 chat.deepseek.com、登录后重启 App 免登。
- 导入：列表可见、导入产生可打开可续聊的正式会话、重复导入跳过。
- 接力：一键开新会话且首条消息含所选内容任务书。
- 回归：不影响既有插件（右侧栏其他 Tab、会话头按钮）。

## 6. 参考

- 现成插件调研结论（2026-10-23）：无单款覆盖 A+B1+B2。Ckarefulon/dsh-deepseek-webchat@0.4.10 提供 guest+快照参考实现（MIT，本插件独立实现，仅借鉴公开行为模式）；wpc0323/deepseek-web-import 提供导入事件序列参考。
