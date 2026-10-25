/**
 * dsh-webseek — host half.
 *
 * Serves the plugin's /api/dsh-webseek routes and owns everything durable:
 * the login snapshot for the desktop guest, the import ledger (idempotency
 * key = DeepSeek conversation id), and the writing of imported conversations
 * as real DSH sessions.
 *
 * Step 1 (skeleton): state route only. Later steps add import and hand-off
 * routes on the same pattern (`ctx.effect(() => ctx.webServer.register(...))`).
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createCorridor } from './corridor.js'

/** Stable cordis plugin name — must equal the `id` in cordis.patch.yml. */
export const name = 'webseek'

/** The only host service this plugin needs. */
export const inject = ['webServer']

/** The page this plugin exists to show. Never an API host, never an iframe. */
export const PAGE_URL = 'https://chat.deepseek.com/'

/** Test hook: lets the test suite redirect the state directory. */
let stateDirOverride = null

/** @returns the plugin's durable state directory (~/.dsh/dsh-webseek). */
export function stateDir() {
  return stateDirOverride ?? join(homedir(), '.dsh', 'dsh-webseek')
}

/** @param dir absolute directory to use instead of the default. */
export function setStateDir(dir) {
  stateDirOverride = dir
}

/** @returns path of the login snapshot file. */
export function sessionFile() {
  return join(stateDir(), 'session.json')
}

/** @returns path of the import ledger (DeepSeek conversation id → DSH session id). */
export function ledgerFile() {
  return join(stateDir(), 'ledger.json')
}

/** Hard cap for the guest lifecycle log before it rotates in place. */
const GUEST_LOG_MAX_BYTES = 1048576

/** @returns path of the guest webview lifecycle log (JSON lines). */
export function guestLogFile() {
  return join(stateDir(), 'guest-log.jsonl')
}

/** Session log format version stamped by DSH 0.2.x (engines.dsh pins <0.3.0). */
export const SESSION_FORMAT_VERSION = 4

/** Longest imported title before truncation. */
const TITLE_MAX = 80

/**
 * Translate a fetched DeepSeek conversation into a DSH session event batch.
 *
 * Shape contract (verified against a live session log, DSH 0.2.1-rc.2):
 * - events are `{type, seq, time, data}`; surface messages (user/message,
 *   assistant/message) additionally carry the outer `surfaceOp:'append'`; `seq` must start at 0 and be
 *   contiguous (the backend asserts `seq === cursor + index`);
 * - `user/message` data is the message itself (`{content, source, role, id}`);
 * - `assistant/message` wraps it (`{turn, step, message, stream}`);
 * - `assistant.message.source` is `{kind:'model', provider, model}` —
 *   `replayState` is optional and omitted for replayed history;
 * - `session/end-seed` closes the seed prefix; `session/title` names the
 *   session with `source:{kind:'fallback'}` and cites the first user seq.
 *
 * Each message becomes its own turn, so no pairing logic is needed; the
 * replayed surface is the conversation as the user lived it.
 * @param messages - `{role:'user'|'assistant', text}` in conversation order.
 * @param title - session title (truncated to TITLE_MAX).
 * @returns the event batch for one `handle.append`.
 */
export function buildImportEvents(messages, title) {
  const events = []
  let seq = 0
  let turn = 0
  let firstUserSeq = -1
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    if (message.role !== 'user' && message.role !== 'assistant') continue
    if (typeof message.text !== 'string' || message.text === '') continue
    turn += 1
    const time = Date.now()
    if (message.role === 'user') {
      if (firstUserSeq === -1) firstUserSeq = seq + 1
      events.push({ type: 'turn/start', seq: seq++, time, data: { turn } })
      events.push({
        type: 'user/message', seq: seq++, time, surfaceOp: 'append',
        data: {
          content: [{ type: 'text', text: message.text }],
          source: { kind: 'user' },
          role: 'user',
          id: randomUUID(),
        },
      })
      events.push({ type: 'turn/end', seq: seq++, time, data: { turn, reason: { kind: 'completed' } } })
    } else {
      events.push({ type: 'turn/start', seq: seq++, time, data: { turn } })
      events.push({ type: 'step/start', seq: seq++, time, data: { turn, step: 1 } })
      events.push({
        type: 'assistant/message', seq: seq++, time, surfaceOp: 'append',
        data: {
          turn, step: 1,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: message.text }],
            source: { kind: 'model', provider: 'deepseek-web', model: 'deepseek-chat' },
            id: randomUUID(),
          },
          stream: [],
        },
      })
      events.push({ type: 'step/end', seq: seq++, time, data: { turn, step: 1 } })
      events.push({ type: 'turn/end', seq: seq++, time, data: { turn, reason: { kind: 'completed' } } })
    }
  }
  const time = Date.now()
  events.push({ type: 'session/end-seed', seq: seq++, time, data: {} })
  events.push({
    type: 'session/title', seq: seq++, time,
    data: {
      title: typeof title === 'string' && title !== '' ? title.slice(0, TITLE_MAX) : 'Imported DeepSeek conversation',
      messageSeqs: firstUserSeq === -1 ? [] : [firstUserSeq],
      source: { kind: 'fallback' },
    },
  })
  return events
}

/**
 * Validate an import request body.
 * @returns `{conversationId, title, messages, workspaceId}` or an error string.
 */
export function validateImportBody(body) {
  if (body === null || typeof body !== 'object') return 'body must be an object'
  if (typeof body.conversationId !== 'string' || body.conversationId === '') return 'conversationId required'
  if (typeof body.workspaceId !== 'string' || body.workspaceId === '') return 'workspaceId required'
  if (typeof body.title !== 'string' || body.title === '') return 'title required'
  if (!Array.isArray(body.messages) || body.messages.length === 0) return 'messages required'
  const messages = body.messages.filter(
    (message) => message !== null && typeof message === 'object'
      && (message.role === 'user' || message.role === 'assistant')
      && typeof message.text === 'string' && message.text !== '',
  )
  if (messages.length === 0) return 'messages has no usable user/assistant text'
  return { conversationId: body.conversationId, title: body.title, messages, workspaceId: body.workspaceId }
}

/**
 * Read a JSON file, tolerating absence and parse errors.
 * @returns parsed value, or null.
 */
export function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return null
  }
}

/**
 * Atomically write a JSON file (temp file + rename) so a crash never leaves a
 * half-written snapshot behind.
 */
export function writeJsonFile(path, value) {
  mkdirSync(join(path, '..'), { recursive: true })
  const temporary = `${path}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temporary, path)
}

/** Send a JSON response. */
export function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** @returns one query parameter of a request URL, or undefined. */
export function queryParam(url, key) {
  return new URL(url, 'http://127.0.0.1').searchParams.get(key) ?? undefined
}

/** @returns the parsed JSON body of a request, or null. */
export function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      try { resolve(JSON.parse(raw)) } catch (error) { resolve(null) }
    })
    req.on('error', () => resolve(null))
  })
}

/** Opening-message templates for the hand-off. zh only: they seed a DSH conversation. */
export const HANDOFF_TEMPLATES = {
  summary: (title, transcript) => '我在 DeepSeek 网页版有一个对话「' + title + '」没有做完，现在把完整记录带到这个会话继续。对话记录如下（U=我，A=DeepSeek）：\n\n' + transcript + '\n\n请先通读记录，然后总结：1) 背景 2) 目标 3) 已有结论与关键决策 4) 未完成事项 5) 建议的下一步。总结完成后等我确认，不要直接开工。',
  implement: (title, transcript) => '我在 DeepSeek 网页版讨论过「' + title + '」，现在把完整记录带到这个会话，按讨论结论直接实现。对话记录如下（U=我，A=DeepSeek）：\n\n' + transcript + '\n\n请先总结结论与待办，然后按结论实现。',
  plan: (title, transcript) => '我在 DeepSeek 网页版讨论过「' + title + '」，现在把完整记录带到这个会话，请基于讨论制定可执行计划。对话记录如下（U=我，A=DeepSeek）：\n\n' + transcript + '\n\n请先总结背景与目标，再给出分步计划（含验收标准），等我确认后开工。',
}

/**
 * Transcribe importable messages into the hand-off transcript.
 * @param {Array<{role:string,text:string}>} messages
 * @returns {string}
 */
export function handoffTranscript(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map((message) => (message.role === 'user' ? 'U: ' : 'A: ') + String(message.text ?? ''))
    .join('\n\n')
}

/** Validate a hand-off body; returns the value, or an error string. */
export function validateHandoffBody(body) {
  if (body === null || typeof body !== 'object') return 'invalid body'
  const { conversationId, title, messages, workspaceId, template } = body
  if (typeof conversationId !== 'string' || conversationId.length === 0) return 'conversationId required'
  if (typeof workspaceId !== 'string' || workspaceId.length === 0) return 'workspaceId required'
  if (!Array.isArray(messages) || messages.length === 0) return 'messages required'
  for (const message of messages) {
    if (message === null || typeof message !== 'object') return 'bad message'
    if (message.role !== 'user' && message.role !== 'assistant') return 'bad message role'
    if (typeof message.text !== 'string' || message.text.length === 0) return 'bad message text'
  }
  const kind = typeof template === 'string' && Object.hasOwn(HANDOFF_TEMPLATES, template) ? template : 'summary'
  return {
    conversationId,
    title: typeof title === 'string' && title.length > 0 ? title : conversationId,
    messages,
    workspaceId,
    kind,
  }
}

/**
 * Plugin activation. The snapshot route guards the desktop guest's login:
 * the client posts `{storage, cookie}` read out of the live page, the host
 * stores it durably; on the next launch the client reads it back and replays
 * it onto a fresh guest partition.
 * @param ctx - host context.
 */
/**
 * Proxy mode for the guest webview session, from `<stateDir>/config.json`
 * (`{"guestProxy":"direct"|"system"}`). Default 'direct': the user's system
 * proxy exit can be blocked by chat.deepseek.com's CloudFront (observed 403
 * "Request blocked" via a SOCKS5 exit, while direct connection loads fine).
 * @returns {'direct'|'system'}
 */
export function guestProxyMode() {
  const config = readJsonFile(join(stateDir(), 'config.json'))
  return config !== null && config !== undefined && config.guestProxy === 'system' ? 'system' : 'direct'
}

/**
 * Whether the local direct corridor should start (from the same
 * `<stateDir>/config.json`, `{"corridor":false}` disables it). Default on:
 * the proxy-exit 403 is the common case, and a listening socket on
 * 127.0.0.1 costs nothing when unused.
 * @returns {boolean}
 */
export function corridorEnabled() {
  const config = readJsonFile(join(stateDir(), 'config.json'))
  return !(config !== null && config !== undefined && config.corridor === false)
}

export function apply(ctx) {
  // Local direct corridor: the guest loads this instead of the real origin so
  // a blocked proxy egress (CloudFront 403) never touches the webview.
  let corridorDisposed = false
  let corridorHandle = null
  if (corridorEnabled()) {
    createCorridor({ log: (message) => ctx.logger?.warn?.(`webseek: ${message}`) })
      .then((corridor) => {
        if (corridorDisposed) {
          corridor.close()
          return
        }
        corridorHandle = corridor
      })
      .catch((error) => {
        ctx.logger?.warn?.(`webseek: corridor failed to start (${error instanceof Error ? error.message : String(error)}); the guest falls back to the real origin`)
      })
  }
  ctx.effect(() => () => {
    corridorDisposed = true
    if (corridorHandle !== null) corridorHandle.close()
  }, 'webseek: corridor')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-webseek/state',
    handler: (req, res) => {
      json(res, 200, {
        ok: true,
        pageUrl: PAGE_URL,
        guestUrl: corridorHandle !== null ? corridorHandle.url : undefined,
        guestProxy: guestProxyMode(),
        sessionQuery: ctx.get('sessionQuery') !== undefined,
        sessionPersistence: ctx.get('sessionPersistence') !== undefined,
        sessions: ctx.get('sessions') !== undefined,
        workspaceRegistry: ctx.get('workspaceRegistry') !== undefined,
        sessionSaved: readJsonFile(sessionFile()) !== null,
      })
    },
  }), 'webseek: state route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-webseek/session',
    handler: async (req, res) => {
      if (req.method === 'POST') {
        const body = await readJsonBody(req)
        if (body === null || typeof body !== 'object'
          || !Array.isArray(body.storage) || typeof body.cookie !== 'string') {
          // Reject rather than coerce: writing a defaulted empty snapshot
          // would silently wipe the saved login state.
          return json(res, 400, { ok: false, error: 'invalid body' })
        }
        const storage = body.storage.filter(
          (pair) => Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string',
        )
        // A guest that never loaded (proxy 403 page, blank state) must not
        // wipe the saved login: refuse to overwrite a non-empty snapshot
        // with an empty one (observed 2026-10-25).
        const incomingHasContent = storage.length > 0 || (typeof body.cookie === 'string' && body.cookie !== '')
        if (!incomingHasContent) {
          const existing = readJsonFile(sessionFile())
          const existingHasContent = existing !== null && typeof existing === 'object'
            && Array.isArray(existing.storage)
            && (existing.storage.length > 0 || (typeof existing.cookie === 'string' && existing.cookie !== ''))
          if (existingHasContent) {
            return json(res, 200, { ok: true, skipped: 'empty snapshot does not overwrite saved login state' })
          }
        }
        writeJsonFile(sessionFile(), { storage, cookie: body.cookie, savedAt: new Date().toISOString() })
        return json(res, 200, { ok: true })
      }
      const snapshot = readJsonFile(sessionFile())
      if (snapshot === null || !Array.isArray(snapshot.storage)) {
        return json(res, 200, { ok: true, exists: false })
      }
      json(res, 200, {
        ok: true,
        exists: true,
        storage: snapshot.storage,
        cookie: typeof snapshot.cookie === 'string' ? snapshot.cookie : '',
      })
    },
  }), 'webseek: session snapshot route')

  // Webview lifecycle breadcrumbs from the client (diagnosis only): appended
  // as JSON lines so a blank guest on the desktop can be traced without the
  // renderer console. Rotates in place past GUEST_LOG_MAX_BYTES.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-webseek/guest-log',
    handler: async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
      const body = await readJsonBody(req)
      const entries = body !== null && typeof body === 'object' && Array.isArray(body.entries) ? body.entries : null
      if (entries === null || entries.length === 0 || entries.length > 100) {
        return json(res, 400, { ok: false, error: 'invalid entries' })
      }
      const lines = entries
        .map((entry) => (typeof entry === 'object' && entry !== null ? JSON.stringify(entry) : null))
        .filter((line) => line !== null && line.length <= 600)
      if (lines.length === 0) return json(res, 400, { ok: false, error: 'no valid entries' })
      const file = guestLogFile()
      mkdirSync(stateDir(), { recursive: true })
      try {
        if (existsSync(file) && statSync(file).size > GUEST_LOG_MAX_BYTES) {
          renameSync(file, file + '.1')
        }
        appendFileSync(file, lines.join('\n') + '\n')
      } catch (error) {
        return json(res, 500, { ok: false, error: String(error instanceof Error ? error.message : error) })
      }
      json(res, 200, { ok: true, written: lines.length })
    },
  }), 'webseek: guest log route')

  // Workspace picker data for the import UI (id + title + path only).
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-webseek/workspaces',
    handler: (req, res) => {
      const workspaces = ctx.get('workspaceRegistry')
      if (workspaces === undefined) return json(res, 200, { ok: true, workspaces: [] })
      json(res, 200, {
        ok: true,
        workspaces: workspaces.list().map((workspace) => ({
          id: workspace.id, title: workspace.title, path: workspace.path,
        })),
      })
    },
  }), 'webseek: workspaces route')

  // Import: write a fetched DeepSeek conversation as a real, cold DSH session
  // and attach it to the chosen workspace. Idempotent per conversation id.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-webseek/import',
    handler: async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
      const parsed = validateImportBody(await readJsonBody(req))
      if (typeof parsed === 'string') return json(res, 400, { ok: false, error: parsed })
      const { conversationId, title, messages, workspaceId } = parsed

      const ledger = readJsonFile(ledgerFile()) ?? {}
      const existing = ledger[conversationId]
      if (existing !== null && typeof existing === 'object' && typeof existing.sessionId === 'string') {
        return json(res, 200, { ok: true, already: true, sessionId: existing.sessionId })
      }

      const persistence = ctx.get('sessionPersistence')
      const workspaces = ctx.get('workspaceRegistry')
      if (persistence === undefined || workspaces === undefined) {
        return json(res, 503, { ok: false, error: 'session services unavailable' })
      }
      const workspace = workspaces.get(workspaceId)
      if (workspace === undefined) return json(res, 400, { ok: false, error: 'unknown workspace' })

      const sessionId = randomUUID()
      const events = buildImportEvents(messages, title)
      try {
        const header = {
          version: SESSION_FORMAT_VERSION,
          id: sessionId,
          createdAt: Date.now(),
          cwd: workspace.path,
          isSeeded: false,
        }
        const handle = await persistence.create(header)
        try {
          await handle.append(events)
          await handle.flush()
        } finally {
          await handle.close()
        }
        await workspace.attachSession(sessionId)
        // Seed the projection cache so the tree row renders immediately:
        // listing reads rows straight from the cache (zero I/O), so a session
        // with no cached projections is invisible in the workspace tree until
        // something folds its log. Folding our own events here is the only
        // moment we hold them; later reads can seed from the log themselves.
        const projectionCache = ctx.get('sessionProjectionCache')
        if (projectionCache !== undefined) {
          try {
            projectionCache.coldSnapshot(header, 0, events)
          } catch (error) {
            ctx.logger?.warn?.(`webseek: projection seed for "${sessionId}" failed (tree shows it after next cold read): ${String(error)}`)
          }
        }
      } catch (error) {
        return json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
      ledger[conversationId] = { sessionId, title, importedAt: new Date().toISOString() }
      writeJsonFile(ledgerFile(), ledger)
      json(res, 200, { ok: true, sessionId, workspaceId })
    },
  }), 'webseek: import route')

  // Ledger read-back for the UI (already-imported marks).
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-webseek/ledger',
    handler: (req, res) => {
      json(res, 200, { ok: true, ledger: readJsonFile(ledgerFile()) ?? {} })
    },
  }), 'webseek: ledger route')

  // Hand-off: create a REAL session in the chosen workspace and admit the
  // transcript as its opening prompt. The summary itself is written by the
  // session's own model (design decision: this plugin never calls an LLM).
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-webseek/handoff',
    handler: async (req, res) => {
      const parsed = validateHandoffBody(await readJsonBody(req))
      if (typeof parsed === 'string') return json(res, 400, { ok: false, error: parsed })
      const { title, messages, workspaceId, kind } = parsed

      const controller = ctx.get('sessionController')
      const workspaces = ctx.get('workspaceRegistry')
      if (controller === undefined) return json(res, 503, { ok: false, error: 'sessionController unavailable' })
      if (workspaces === undefined || workspaces.get(workspaceId) === undefined) {
        return json(res, 400, { ok: false, error: 'unknown workspace' })
      }

      let sessionId
      try {
        const created = await controller.create({ workspaceId })
        sessionId = created.sessionId
      } catch (error) {
        return json(res, 502, { ok: false, error: 'create failed: ' + (error instanceof Error ? error.message : String(error)) })
      }

      const requestId = randomUUID()
      const text = HANDOFF_TEMPLATES[kind](title, handoffTranscript(messages))
      try {
        // The controller's prompt is the Remote method: it builds the durable
        // source itself and only wants a caller cancellation signal here.
        await controller.prompt(
          { sessionId, requestId, content: [{ type: 'text', text }] },
          new AbortController().signal,
        )
      } catch (error) {
        // The session exists even if the prompt was refused; report both.
        return json(res, 502, {
          ok: false,
          sessionId,
          error: 'prompt refused: ' + (error instanceof Error ? error.message : String(error)),
        })
      }
      json(res, 200, { ok: true, sessionId, workspaceId })
    },
  }), 'webseek: handoff route')
}
