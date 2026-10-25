# dsh-webseek

Embed the real chat.deepseek.com web app inside DeepSeek Harness (DSH), import web conversations as real DSH sessions, and hand a web conversation off into a brand-new DSH session.

English | [中文](#中文)

## Features

- **Embedded web panel** — a "Web DeepSeek" tab in DSH's right sidebar renders the real chat.deepseek.com page through the desktop shell's browser guest channel (not an iframe; the site forbids framing). Log in once inside the panel; the login snapshot is saved and replayed automatically on the next launch.
- **History import** — pull your DeepSeek conversation list (latest 100), select any of them, and import into a chosen DSH workspace as **real sessions**: each message becomes a proper turn in the session log, the tree shows them after a page reload, and they are ordinary sessions — open, continue, search, archive like any other.
- **Hand-off** — turn one web conversation into a brand-new DSH session with the transcript seeded as the opening prompt. The session's own model summarizes (background / goal / decisions / open items / next steps) before any work starts. Three templates: summarize, implement, plan. The new session opens automatically when the UI service is available.
- **Web profile degraded mode** — the plugin also installs on plain `dsh web`; import/hand-off need the embedded page, so those sections show a desktop-only hint instead of failing.

## Install

```bash
dsh plugin --profile desktop add dsh-webseek   # npm name once published
dsh plugin --profile web add dsh-webseek       # optional, degraded mode
```

Restart the desktop app (⌘Q, then reopen) or the web instance.

## Use

1. Open a session, click **Web DeepSeek** in the right sidebar.
2. Log in to chat.deepseek.com inside the panel (once).
3. **Import web history**: fetch the list → check conversations → pick a workspace → Import. Reload the page to see the new sessions in the tree.
4. **Hand off**: click *Hand off* on a conversation row; a new session opens with the transcript and a summary-first instruction.

## Notes & limits

- Import and hand-off run **inside the embedded page** (same-origin fetch with the real cookies); the plugin never stores your DeepSeek token anywhere else — the login snapshot lives in `~/.dsh/dsh-webseek/session.json`.
- **Local direct corridor**: if your machine routes all traffic through a proxy whose egress is blocked by chat.deepseek.com (403), the desktop panel loads `http://127.0.0.1:37890` instead — a local reverse proxy to the real origin that reaches it directly. Disable it with `~/.dsh/dsh-webseek/config.json` → `{"corridor":false}`.
- WeChat QR sign-in does not work through the corridor (WeChat validates the redirect domain); use phone + SMS code or password sign-in.
- DeepSeek's API returns the latest 100 conversations per page; older ones are not listed.
- Conversations are imported read-only: what you say next happens in DSH, not back on the web page.
- Requires DSH `>=0.2.0-rc.2 <0.3.0` and Node `>=22`.

---

# 中文

把真正的 chat.deepseek.com 网页嵌进 DeepSeek Harness（DSH），把网页对话导入为真正的 DSH 会话，或把一段网页对话接力成一个全新的 DSH 会话。

## 功能

- **内嵌网页面板** — DSH 右侧栏新增「网页 DeepSeek」标签页，通过桌面壳的 browser guest 通道渲染真正的 chat.deepseek.com（不是 iframe，站点本身禁止被嵌）。在面板里登录一次，登录快照会自动保存并在下次启动时回放。
- **历史导入** — 拉取 DeepSeek 会话列表（最新 100 条），勾选任意几条导入到指定 DSH 工作区，成为**真正的会话**：每条消息都写入会话日志的正确轮次，刷新页面后会话树可见，之后和普通会话一样打开、续聊、检索、归档。
- **总结接力** — 把一段网页对话变成全新的 DSH 会话：完整记录作为开场消息注入，由会话模型先总结（背景 / 目标 / 关键决策 / 未完成事项 / 下一步），确认后再开工。三种模板：总结接力 / 按结论实现 / 制定计划。UI 服务可用时新会话自动打开。
- **web 降级** — 插件也装在纯 `dsh web` 实例上；导入/接力依赖内嵌网页，这两块会显示「需要桌面版」提示而不是报错。

## 安装

```bash
dsh plugin --profile desktop add dsh-webseek   # 发布后为 npm 包名
dsh plugin --profile web add dsh-webseek       # 可选，降级模式
```

桌面端 ⌘Q 完全退出后重开；web 实例重启生效。

## 使用

1. 打开任意会话，右侧栏点 **网页 DeepSeek**。
2. 在面板内登录 chat.deepseek.com（一次）。
3. **导入网页历史**：拉取列表 → 勾选会话 → 选工作区 → 导入。刷新页面后会话树可见。
4. **接力**：点会话行的「接力」，新会话自动打开并带着完整记录与总结指令。

## 说明与限制

- 导入与接力都在**内嵌页面里**发请求（同源 fetch 带真实 cookie）；插件不会把你的 DeepSeek 凭据存到别处——登录快照只落在 `~/.dsh/dsh-webseek/session.json`。
- **本地直连走廊**：若本机全部流量走代理且代理出口被 chat.deepseek.com 拦截（403），桌面面板会改走 `http://127.0.0.1:37890`——一个直连真实站点的本地反向代理。在 `~/.dsh/dsh-webseek/config.json` 写 `{"corridor":false}` 可关闭。
- 走廊下微信扫码登录不可用（微信校验回调域名）；请用手机验证码或密码登录。
- DeepSeek 接口每次返回最新 100 个会话，更早的不会列出。
- 导入是只读的：后续对话发生在 DSH 里，不会回写网页。
- 需要 DSH `>=0.2.0-rc.2 <0.3.0`，Node `>=22`。
