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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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

/**
 * Plugin activation. The snapshot route guards the desktop guest's login:
 * the client posts `{storage, cookie}` read out of the live page, the host
 * stores it durably; on the next launch the client reads it back and replays
 * it onto a fresh guest partition.
 * @param ctx - host context.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-webseek/state',
    handler: (req, res) => {
      json(res, 200, {
        ok: true,
        pageUrl: PAGE_URL,
        sessionQuery: ctx.get('sessionQuery') !== undefined,
        sessionPersistence: ctx.get('sessionPersistence') !== undefined,
        sessions: ctx.get('sessions') !== undefined,
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
}
