/**
 * dsh-webseek — host half.
 *
 * Serves the plugin's /api/dsh-webseek routes and owns everything durable:
 * the import ledger (idempotency) and the writing of an imported
 * conversation as a real DSH session.
 *
 * The plugin's whole job now is one thing: a *public* DeepSeek share link
 * (`https://chat.deepseek.com/share/<id>`) becomes a DSH session in a chosen
 * workspace, with the same title. The content comes from the same endpoint
 * the web app uses, so no login and no embedded browser are involved:
 *
 *   GET https://chat.deepseek.com/api/v0/share/content?share_id=<id>
 *
 * The pure half (id check, main-line walk, message mapping) lives in
 * ./share.js so it can be unit-tested offline.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mapShareMessages, parseShareId, shareTitle, SHARE_BODY_LIMIT, SHARE_CONTENT_URL } from './share.js'

/** Stable cordis plugin name — must equal the `id` in cordis.patch.yml. */
export const name = 'webseek'

/** The only host service this plugin needs. */
export const inject = ['webServer']

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

/** @returns path of the import ledger (ledger key → DSH session id). */
export function ledgerFile() {
  return join(stateDir(), 'ledger.json')
}

/** Session log format version stamped by DSH 0.2.x (engines.dsh pins <0.3.0). */
export const SESSION_FORMAT_VERSION = 4

/** The version this host is actually running, read from its own package.json. */
export const PLUGIN_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'))
    return typeof pkg?.version === 'string' && pkg.version !== '' ? pkg.version : '0.0.0'
  } catch (error) {
    return '0.0.0'
  }
})()

/** Longest imported title before truncation. */
const TITLE_MAX = 80

/** How long the share request may take before it is given up on. */
const SHARE_TIMEOUT_MS = 10000

/** How long the npm registry may take to answer the version check. */
const UPDATE_TIMEOUT_MS = 8000

/** Upper bound for a request body; an import request is two short strings. */
const BODY_LIMIT = 64 * 1024

/**
 * A browser-shaped User-Agent. The edge answers a bare client with its own
 * HTML error page instead of JSON, and the share endpoint is a browser API.
 */
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

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
 * Each user message and the answer that replied to it share one turn, which
 * is the shape DSH itself writes (see the comment on `closeTurn`); the
 * replayed surface is then the conversation as the user lived it.
 * @param messages - `{role:'user'|'assistant', text}` in conversation order.
 * @param title - session title (truncated to TITLE_MAX).
 * @returns the event batch for one `handle.append`.
 */
export function buildImportEvents(messages, title) {
	const events = []
	let seq = 0
	let turn = 0
	let firstUserSeq = -1
	const time = Date.now()
	const push = (type, data, extra) => {
		events.push({ type, seq: seq++, time, data, ...(extra ?? {}) })
	}
	// One turn per user message, with the answer that replied to it inside the
	// same turn: DSH's own log reads
	//   turn/start → step/start → user/message → assistant/message → step/end → turn/end
	// and a fold that expects that shape drops an answer that sits in a turn of
	// its own (the symptom: only the first user message shows up).
	const closeTurn = (userText, assistantText) => {
		turn += 1
		push('turn/start', { turn })
		push('step/start', { turn, step: 1 })
		if (userText !== null) {
			if (firstUserSeq === -1) firstUserSeq = seq
			push('user/message', {
				content: [{ type: 'text', text: userText }],
				source: { kind: 'user' },
				role: 'user',
				id: randomUUID(),
			}, { surfaceOp: 'append' })
		}
		if (assistantText !== null) {
			push('assistant/message', {
				turn,
				step: 1,
				message: {
					role: 'assistant',
					content: [{ type: 'text', text: assistantText }],
					source: { kind: 'model', provider: 'deepseek-web', model: 'deepseek-chat' },
					id: randomUUID(),
				},
				stream: [],
			}, { surfaceOp: 'append' })
		}
		push('step/end', { turn, step: 1 })
		push('turn/end', { turn, reason: { kind: 'completed' } })
	}
	let pendingUser = null
	for (const message of messages) {
		if (message === null || typeof message !== 'object') continue
		const text = typeof message.text === 'string' ? message.text : ''
		if (text === '') continue
		if (message.role === 'user') {
			if (pendingUser !== null) closeTurn(pendingUser, null) // a question that never got an answer
			pendingUser = text
			continue
		}
		if (message.role === 'assistant') {
			closeTurn(pendingUser, text)
			pendingUser = null
		}
	}
	if (pendingUser !== null) closeTurn(pendingUser, null)
  push('session/title', {
		title: typeof title === 'string' && title !== '' ? title.slice(0, TITLE_MAX) : 'Imported DeepSeek conversation',
		messageSeqs: firstUserSeq === -1 ? [] : [firstUserSeq],
		source: { kind: 'fallback' },
	})
	// `session/end-seed` closes the seeded history and is the last event of a
	// seeded log.
	push('session/end-seed', {})
	return events
}

/**
 * Validate a share-import request body.
 * @param body - the parsed request body.
 * @returns `{shareId, workspaceId}` or an error string.
 */
export function validateShareImportBody(body) {
  if (body === null || typeof body !== 'object') return 'body must be an object'
  if (typeof body.workspaceId !== 'string' || body.workspaceId === '') return 'workspaceId required'
  const shareId = parseShareId(body.shareUrl ?? body.shareId)
  if (shareId === null) return 'invalid share link'
  return { shareId, workspaceId: body.workspaceId }
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
 * half-written file behind.
 */
/** Distinguishes concurrent scratch files. */
let ledgerWriteCounter = 0

/**
 * Write a JSON file atomically.
 *
 * The write stays synchronous on purpose: a failed write has to surface at
 * the call site (the route turns it into a 500), not as a floating rejected
 * promise. The temporary name carries the process id and a counter so two
 * writers never share one scratch file.
 * @param path - the target file.
 * @param value - the JSON value to store.
 */
export function writeJsonFile(path, value) {
  mkdirSync(join(path, '..'), { recursive: true })
  const temporary = `${path}.${process.pid}.${ledgerWriteCounter++}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temporary, path)
}

/**
 * Read the ledger, change it, and write it back — in one synchronous step.
 *
 * The import awaits the network and the disk between its first read and its
 * write, so the file has to be re-read right before the write: otherwise two
 * concurrent imports of different shares overwrite each other and one entry
 * is lost (the same share could then be imported twice).
 * @param change - receives the ledger, mutates it, and returns the new value.
 * @returns the written ledger.
 */
export function updateLedger(change) {
  const ledger = readJsonFile(ledgerFile()) ?? {}
  const next = change(ledger) ?? ledger
  writeJsonFile(ledgerFile(), next)
  return next
}

/** Send a JSON response. */
export function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** @returns the parsed JSON body of a request, or null. */
export function readJsonBody(req) {
	return new Promise((resolve) => {
		let raw = ''
		let overflow = false
		req.on('data', (chunk) => {
			if (overflow) return
			raw += chunk
			// A body bigger than any import request is either a mistake or an
			// attack; either way it is not parsed.
			if (raw.length > BODY_LIMIT) {
				overflow = true
				raw = ''
				resolve(null)
			}
		})
		req.on('end', () => {
			if (overflow) return
			try { resolve(JSON.parse(raw)) } catch (error) { resolve(null) }
		})
		req.on('error', () => resolve(null))
		req.on('aborted', () => resolve(null))
	})
}

/**
 * Read one raw share response into an import decision.
 *
 * The endpoint answers in three very different shapes and they must not be
 * confused: a JSON body with the conversation, a JSON body with a non-zero
 * `biz_code` (the share is gone), and — when the edge is not happy — an HTML
 * error page (rate limit, blocked). The status is checked before the body is
 * parsed, because the HTML page is not JSON at all.
 * @param response - `{status, contentType, text}`.
 * @returns `{ok: true, title, messages}` or `{ok: false, code}`.
 */
export function evaluateShareResponse(response) {
  const status = typeof response?.status === 'number' ? response.status : 0
  if (status === 429) return { ok: false, code: 'rate-limited' }
  if (status >= 300 && status < 400) return { ok: false, code: 'bad-response' }
  if (status !== 200) return { ok: false, code: 'bad-response' }
  if (typeof response.contentType === 'string' && !response.contentType.includes('json')) {
    return { ok: false, code: 'bad-response' }
  }
  let payload
  try {
    payload = JSON.parse(response.text)
  } catch (error) {
    return { ok: false, code: 'bad-response' }
  }
  const data = payload !== null && typeof payload === 'object' ? payload.data : null
  if (data === null || typeof data !== 'object' || data.biz_code !== 0) {
    return { ok: false, code: 'not-found' }
  }
  const biz = data.biz_data !== null && typeof data.biz_data === 'object' ? data.biz_data : {}
  const messages = mapShareMessages(biz.messages)
  if (messages.length === 0) return { ok: false, code: 'empty' }
  return { ok: true, title: shareTitle(biz.title), messages }
}

/**
 * Fetch a shared conversation's content.
 *
 * The request is a direct (proxy-free) HTTPS call: this process does not use
 * the system proxy, which is what makes the call work on a machine whose
 * proxy exit the edge blocks. Only the fixed endpoint is ever contacted — the
 * user's link contributes nothing but the validated id.
 * @param shareId - the validated share id.
 * @returns {Promise<{ok: true, title: string, messages: object[]} | {ok: false, code: string}>}
 */
export function fetchShareContent(shareId) {
	return new Promise((resolve) => {
		let settled = false
		const finish = (value) => {
			if (settled) return
			settled = true
			clearTimeout(deadline)
			resolve(value)
		}
		// A socket idle timeout only fires while nothing is flowing: an
		// upstream that dies mid-body would otherwise leave the request
		// pending forever, so the whole call carries its own deadline.
		const deadline = setTimeout(() => {
			try { request.destroy() } catch (error) { /* already gone */ }
			finish({ ok: false, code: 'timeout' })
		}, SHARE_TIMEOUT_MS)
		const path = '/api/v0/share/content?share_id=' + encodeURIComponent(shareId)
		const request = httpsRequest({
			host: 'chat.deepseek.com',
			port: 443,
			path,
			method: 'GET',
			headers: {
				'user-agent': BROWSER_UA,
				accept: 'application/json',
				'accept-encoding': 'identity',
			},
		}, (response) => {
			const status = response.statusCode ?? 0
			const contentType = String(response.headers['content-type'] ?? '')
			if (status !== 200) {
				response.resume()
				finish(evaluateShareResponse({ status, contentType, text: '' }))
				return
			}
			const chunks = []
			let size = 0
			response.on('data', (chunk) => {
				size += chunk.length
				if (size > SHARE_BODY_LIMIT) {
					request.destroy()
					finish({ ok: false, code: 'too-large' })
					return
				}
				chunks.push(chunk)
			})
			response.on('end', () => {
				finish(evaluateShareResponse({
					status,
					contentType,
					text: Buffer.concat(chunks).toString('utf8'),
				}))
			})
			// A connection that breaks mid-body never reaches 'end'.
			response.on('aborted', () => finish({ ok: false, code: 'network' }))
			response.on('error', () => finish({ ok: false, code: 'network' }))
			response.on('close', () => finish({ ok: false, code: 'network' }))
		})
		request.setTimeout(SHARE_TIMEOUT_MS, () => {
			request.destroy()
			finish({ ok: false, code: 'timeout' })
		})
		request.on('error', () => finish({ ok: false, code: 'network' }))
		request.end()
	})
}

/**
 * Compare two dotted versions. Only the numeric parts decide the order; a
 * `-prerelease` suffix is ignored (the footer compares released versions).
 * @param a - left version, e.g. "0.2.0".
 * @param b - right version, e.g. "0.2.1".
 * @returns 1 when a > b, -1 when a < b, 0 when equal.
 */
export function compareVersions(a, b) {
  const parts = (value) => String(value).split('-')[0].split('.').map((piece) => {
    const parsed = Number.parseInt(piece, 10)
    return Number.isFinite(parsed) ? parsed : 0
  })
  const left = parts(a)
  const right = parts(b)
  const count = Math.max(left.length, right.length)
  for (let index = 0; index < count; index += 1) {
    const x = left[index] ?? 0
    const y = right[index] ?? 0
    if (x > y) return 1
    if (x < y) return -1
  }
  return 0
}

/**
 * Turn a registry `/latest` reply into an update verdict.
 * @param response - `{status, text}` (a 404 means "never published").
 * @param currentVersion - the version this host is running.
 * @returns `{ok: true, current, latest, hasUpdate}` or `{ok: false, code}`.
 */
export function evaluateVersionResponse(response, currentVersion) {
  const status = typeof response?.status === 'number' ? response.status : 0
  if (status === 404) return { ok: false, code: 'not-published' }
  if (status !== 200) return { ok: false, code: 'bad-response' }
  let payload
  try {
    payload = JSON.parse(response.text)
  } catch (error) {
    return { ok: false, code: 'bad-response' }
  }
  const latest = payload !== null && typeof payload === 'object' && typeof payload.version === 'string'
    ? payload.version.trim()
    : ''
  if (latest === '' || !/^\d+\.\d+\.\d+/.test(latest)) return { ok: false, code: 'bad-response' }
  return { ok: true, current: currentVersion, latest, hasUpdate: compareVersions(latest, currentVersion) > 0 }
}

/**
 * Ask npm for the latest published version of this plugin.
 *
 * Like the share fetch this is a direct HTTPS call (no system proxy), so it
 * works on a machine whose proxy exit the registry does not like.
 * @returns {Promise<object>} the {@link evaluateVersionResponse} verdict.
 */
export function fetchLatestVersion() {
	return new Promise((resolve) => {
		let settled = false
		const finish = (value) => {
			if (settled) return
			settled = true
			clearTimeout(deadline)
			resolve(value)
		}
		const deadline = setTimeout(() => {
			try { request.destroy() } catch (error) { /* already gone */ }
			finish({ ok: false, code: 'timeout' })
		}, UPDATE_TIMEOUT_MS)
		const request = httpsRequest({
			host: 'registry.npmjs.org',
			port: 443,
			path: '/dsh-webseek/latest',
			method: 'GET',
			headers: {
				'user-agent': BROWSER_UA,
				accept: 'application/json',
				'accept-encoding': 'identity',
			},
		}, (response) => {
			const status = response.statusCode ?? 0
			if (status !== 200 && status !== 404) {
				response.resume()
				finish(evaluateVersionResponse({ status, text: '' }, PLUGIN_VERSION))
				return
			}
			const chunks = []
			let size = 0
			response.on('data', (chunk) => {
				size += chunk.length
				if (size > SHARE_BODY_LIMIT) {
					request.destroy()
					finish({ ok: false, code: 'too-large' })
					return
				}
				chunks.push(chunk)
			})
			response.on('end', () => {
				finish(evaluateVersionResponse({
					status,
					text: Buffer.concat(chunks).toString('utf8'),
				}, PLUGIN_VERSION))
			})
			response.on('aborted', () => finish({ ok: false, code: 'network' }))
			response.on('error', () => finish({ ok: false, code: 'network' }))
			response.on('close', () => finish({ ok: false, code: 'network' }))
		})
		request.setTimeout(UPDATE_TIMEOUT_MS, () => {
			request.destroy()
			finish({ ok: false, code: 'timeout' })
		})
		request.on('error', () => finish({ ok: false, code: 'network' }))
		request.end()
	})
}

/**
 * Write an imported conversation as a real, cold DSH session and attach it
 * to the chosen workspace. Idempotent per ledger key.
 * @param ctx - host context (session services are read from it).
 * @param input - `{title, messages, workspaceId, ledgerKey}`.
 * @returns {Promise<{already: boolean, sessionId: string, workspaceId: string, title: string}>}
 */
/** In-flight imports per ledger key: two parallel imports of the same share
 * would race on the ledger file and lose one entry. */
const importsInFlight = new Map()

export async function createImportedSession(ctx, input) {
  const key = input?.ledgerKey ?? ''
  if (key === '') throw new Error('ledgerKey required')
  const running = importsInFlight.get(key)
  if (running !== undefined) return running
  const promise = createImportedSessionNow(ctx, input)
  importsInFlight.set(key, promise)
  try {
    return await promise
  } finally {
    importsInFlight.delete(key)
  }
}

/**
 * The actual import: write the session, then record it.
 * @param ctx - host context.
 * @param input - `{title, messages, workspaceId, ledgerKey}`.
 * @returns {Promise<{already: boolean, sessionId: string, workspaceId: string, title: string}>}
 */
async function createImportedSessionNow(ctx, { title, messages, workspaceId, ledgerKey }) {
  const ledger = readJsonFile(ledgerFile()) ?? {}
  const existing = ledger[ledgerKey]
  // Only a finished import counts as done: a crashed run leaves a `pending`
  // reservation behind, and that one has to be redone rather than answered
  // with a session that was never written.
  // A ledger entry written before the `state` field existed counts as done.
  if (existing !== null && typeof existing === 'object'
    && typeof existing.sessionId === 'string' && (existing.state ?? 'done') === 'done') {
    return {
      already: true,
      sessionId: existing.sessionId,
      workspaceId: typeof existing.workspaceId === 'string' ? existing.workspaceId : workspaceId,
      title: typeof existing.title === 'string' ? existing.title : title,
    }
  }

  const persistence = ctx.get('sessionPersistence')
  const workspaces = ctx.get('workspaceRegistry')
  if (persistence === undefined || workspaces === undefined) {
    throw new Error('session services unavailable')
  }
  const workspace = workspaces.get(workspaceId)
  if (workspace === undefined) throw new Error('unknown workspace')

  // DSH names its sessions `session-<uuid>`; the tree and the client's
  // openSession() both key on that exact id, so a bare uuid would create a
  // session nobody can open.
  const sessionId = `session-${randomUUID()}`
  const events = buildImportEvents(messages, title)
  const header = {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: Date.now(),
    cwd: workspace.path,
    isSeeded: false,
    // `agentPreset` stays unset on purpose: it is optional, and a session
    // without one falls back to the deployment default, while a hard-coded
    // preset id would break the session as soon as that preset is renamed.
  }
  // Reserve the ledger key before the session exists: a second import that
  // arrives while this one is still writing must not build a duplicate, and a
  // failed import must not leave the key behind.
  updateLedger((book) => {
    book[ledgerKey] = { sessionId, title, workspaceId, state: 'pending', importedAt: new Date().toISOString() }
  })
  try {
    const handle = await persistence.create(header)
    try {
      await handle.append(events)
      await handle.flush()
    } finally {
      await handle.close()
    }
    await workspace.attachSession(sessionId)
  } catch (error) {
    // The write failed: drop the reservation so a retry can try again. The
    // half-written log (if any) is not attached to the workspace, so the tree
    // does not show it.
    updateLedger((book) => { delete book[ledgerKey] })
    throw error
  }
  // Seed the projection cache so the tree row renders immediately: listing
  // reads rows straight from the cache (zero I/O), so a session with no cached
  // projections is invisible in the workspace tree until something folds its
  // log. Folding our own events here is the only moment we hold them; later
  // reads can seed from the log themselves.
  const projectionCache = ctx.get('sessionProjectionCache')
  if (projectionCache !== undefined) {
  	try {
  		projectionCache.coldSnapshot(header, 0, events)
  	} catch (error) {
  		ctx.logger?.warn?.(`webseek: projection seed for "${sessionId}" failed (tree shows it after next cold read): ${String(error)}`)
  	}
  }
  updateLedger((book) => {
    book[ledgerKey] = { sessionId, title, workspaceId, state: 'done', importedAt: new Date().toISOString() }
  })
  return { already: false, sessionId, workspaceId, title }
}

/**
 * Plugin activation.
 * @param ctx - host context.
 */
export function apply(ctx) {
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

  // Ledger read-back for the UI (already-imported marks).
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-webseek/ledger',
    handler: (req, res) => {
      json(res, 200, { ok: true, ledger: readJsonFile(ledgerFile()) ?? {} })
    },
  }), 'webseek: ledger route')

  // Import a shared conversation: validate the link, fetch it, write it as a
  // cold session in the chosen workspace.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-webseek/share-import',
    handler: async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
      const parsed = validateShareImportBody(await readJsonBody(req))
      if (typeof parsed === 'string') return json(res, 400, { ok: false, error: parsed })
      const { shareId, workspaceId } = parsed
      const workspaces = ctx.get('workspaceRegistry')
      if (workspaces === undefined) return json(res, 503, { ok: false, error: 'workspaceRegistry unavailable' })
      const workspace = workspaces.get(workspaceId)
      if (workspace === undefined) {
        return json(res, 400, { ok: false, error: 'unknown workspace' })
      }
      const fetched = await fetchShareContent(shareId)
      if (fetched.ok !== true) {
        const status = fetched.code === 'rate-limited' ? 429 : 502
        return json(res, status, { ok: false, error: fetched.code })
      }
      try {
        const created = await createImportedSession(ctx, {
          title: fetched.title,
          messages: fetched.messages,
          workspaceId,
          ledgerKey: 'share:' + shareId,
        })
        // The session may live in another workspace (an earlier import); the
        // title has to name where it actually is.
        const home = created.workspaceId === workspaceId
          ? workspace
          : workspaces.get(created.workspaceId)
        json(res, 200, { ok: true, shareId, workspaceTitle: home?.title ?? workspace.title, ...created })
      } catch (error) {
        // The details (paths, ids) stay in the host log; the browser gets a
        // stable code it can explain.
        ctx.logger?.warn?.(`webseek: share import failed for "${shareId}": ${String(error)}`)
        json(res, 500, { ok: false, error: 'import-failed' })
      }
    },
  }), 'webseek: share import route')

  // Latest published version, so the dialog footer can say "up to date" or
  // name the update. Always 200: the body's `ok` explains what happened.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-webseek/update-check',
    handler: async (req, res) => {
      json(res, 200, await fetchLatestVersion())
    },
  }), 'webseek: update-check route')
}
