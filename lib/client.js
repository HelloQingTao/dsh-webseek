/**
 * dsh-webseek — browser half.
 *
 * A right-sidebar tab that embeds the real chat.deepseek.com web app through
 * the desktop shell's browser guest channel, imports web conversations into
 * DSH as real sessions, and hands a summarized task off into a brand-new DSH
 * session.
 *
 * ## Why this is not an iframe
 *
 * chat.deepseek.com answers with `Content-Security-Policy: frame-ancestors
 * 'none'`, so an `<iframe>` is refused by the page itself. The only way in is
 * the desktop shell's browser guest: this bundle asks
 * `globalThis.dshDesktop.browser.acquire(workspace)` for a reservation and
 * attaches a `<webview>` with the lease-issued partition. The shell's
 * `will-attach-webview` matches the lease and lets the navigation through.
 *
 * ## Why the guest will live outside React
 *
 * A `<webview>` is destroyed when it leaves the document. If the slot owned
 * it, every tab switch would tear the page down. The guest element lives in a
 * container this plugin owns at the document root; the tab body only measures
 * its area and the guest is positioned onto that rectangle. (Step 4 wires
 * this; the skeleton only reports bridge availability.)
 *
 * ## Skeleton scope (step 1)
 *
 * Registers the sidebar tab type and body, detects the desktop bridge and the
 * host state route, and renders a status card. Nothing navigates yet.
 */
window.__ModuleLoader__.load({
	id: 'dsh-webseek',
	factory: (require) => {
		const module = { exports: {} }
		const exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const React = require('react')
		console.info('[dsh-webseek] client factory loaded')

		const h = React.createElement

		/** Locale namespace, and the i18n key for this plugin's copy. */
		const NS = 'dsh-webseek'

		/** The tab type id; the slot dispatch key for this plugin's body. */
		const TAB_ID = 'dsh-webseek'

		/** The tab kind. Unique per profile — the type registry keys on it. */
		const TAB_KIND = 'webseek'

		/** The workspace key asked of the shell's browser bridge. */
		const WORKSPACE = 'webseek'

		/** The page the guest loads. Kept here: client and host bundles are separate modules. */
		const PAGE_URL = 'https://chat.deepseek.com/'

		/**
		 * @returns the desktop browser bridge, or undefined off the desktop
		 * shell (plain `dsh web` in a system browser has no such channel).
		 */
		function bridge() {
			const carrier = globalThis.dshDesktop
			if (carrier === null || carrier === undefined) return undefined
			if (carrier.protocolVersion !== 1) return undefined
			const browser = carrier.browser
			if (browser === null || browser === undefined) return undefined
			if (typeof browser.acquire !== 'function') return undefined
			return browser
		}

		/** How often the live guest's login state is snapshotted to the host. */
		const SAVE_INTERVAL_MS = 30000

		/**
		 * A plain-Chrome user agent. chat.deepseek.com downgrades its app for
		 * Electron-flavoured UAs; the shell already isolates the guest, so the
		 * page may as well see a browser it trusts.
		 * @returns {string} the cleaned UA, or '' when unrecognizable.
		 */
		function cleanUserAgent() {
			const ua = typeof navigator === 'object' && typeof navigator.userAgent === 'string'
				? navigator.userAgent
				: ''
			const platform = (ua.match(/^Mozilla\/5\.0 \([^)]*\)/) || [])[0]
			const chrome = (ua.match(/Chrome\/([0-9]+)/) || [])[1]
			if (platform === undefined || chrome === undefined) return ''
			return platform + ' AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + chrome + '.0.0.0 Safari/537.36'
		}

		/**
		 * Read the guest's login state (localStorage pairs + document.cookie).
		 * Runs inside the page, so it must be a plain string of JS.
		 * @param element - the live webview.
		 */
		function readGuestState(element) {
			return element.executeJavaScript(
				'JSON.stringify({ storage: Object.keys(localStorage).map(function (key) { return [key, localStorage.getItem(key)] }), cookie: document.cookie })',
			)
		}

		/**
		 * Write a login state back into the page (non-HttpOnly cookies only —
		 * DeepSeek's web credential lives in localStorage.userToken, which this
		 * round-trip preserves).
		 * @param element - the live webview.
		 * @param state - `{ storage, cookie }`.
		 */
		function writeGuestState(element, state) {
			return element.executeJavaScript(
				'(function () { var state = ' + JSON.stringify(state) + ';'
				+ ' var storage = Array.isArray(state.storage) ? state.storage : [];'
				+ ' for (var i = 0; i < storage.length; i++) { try { localStorage.setItem(storage[i][0], storage[i][1]) } catch (error) {} }'
				+ " if (typeof state.cookie === 'string' && state.cookie !== '') {"
				+ " var parts = state.cookie.split('; ');"
				+ ' for (var j = 0; j < parts.length; j++) {'
				+ ' var pair = parts[j];'
				+ " if (pair.indexOf('=') === -1) continue;"
				+ " try { document.cookie = pair + '; path=/' } catch (error) {}"
				+ ' } }'
				+ ' return true })()',
			)
		}

		/**
		 * Whether the guest is on the real origin. The guest starts on
		 * `about:blank#<lease>` (opaque origin: localStorage throws, cookies are
		 * empty) — reading or writing state there would blank the snapshot that
		 * the next launch needs, so both directions are confined to the origin.
		 * @param element - the live webview.
		 * @returns {boolean}
		 */
		function onDeepSeekOrigin(element) {
			try {
				return new URL(element.getURL()).hostname === 'chat.deepseek.com'
			} catch (error) {
				return false
			}
		}

		/** The live guest record, once mounted. */
		let guest = null
		/** In-flight acquire, so concurrent tab mounts share one reservation. */
		let acquiring = null
		/** The acquire failure, if any (shown in the panel). */
		let guestFailure = null

		/** Fired on the window whenever the guest's lifecycle state moves. */
		function notifyGuest() {
			window.dispatchEvent(new CustomEvent('dsh-webseek-guest'))
		}

		/** @returns the saved snapshot from the host, or null when there is none. */
		async function restoreGuestState() {
			try {
				const response = await fetch('/api/dsh-webseek/session')
				const body = await response.json()
				if (body !== null && typeof body === 'object' && body.exists === true) {
					return { storage: Array.isArray(body.storage) ? body.storage : [], cookie: typeof body.cookie === 'string' ? body.cookie : '' }
				}
			} catch (error) { /* first launch, or the host is mid-restart */ }
			return null
		}

		/**
		 * Push the guest's login state to the host. Refuses off-origin reads so
		 * a blank page can never overwrite the stored snapshot.
		 * @param withState - include what only the live page can read.
		 */
		async function saveGuestState(withState) {
			if (guest === null || !onDeepSeekOrigin(guest.element)) return
			let state = { storage: [], cookie: '' }
			if (withState) {
				try {
					state = JSON.parse(await readGuestState(guest.element))
				} catch (error) {
					return // not ready; keep whatever the host already has
				}
			}
			try {
				await fetch('/api/dsh-webseek/session', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						storage: Array.isArray(state?.storage) ? state.storage : [],
						cookie: typeof state?.cookie === 'string' ? state.cookie : '',
					}),
				})
			} catch (error) { /* a failed snapshot costs a login, not the page */ }
		}

		/**
		 * Acquire the guest and keep it alive. Idempotent; concurrent callers
		 * share the single in-flight acquire. On first launch after login the
		 * saved state is replayed once the page first reaches its real origin,
		 * then the page reloads — signed in.
		 * @returns the in-flight promise.
		 */
		function ensureGuest() {
			if (guest !== null) return Promise.resolve()
			const browser = bridge()
			if (browser === undefined) return Promise.resolve()
			if (acquiring !== null) return acquiring
			acquiring = (async () => {
				try {
					const reservation = await browser.acquire(WORKSPACE)
					if (reservation === null || typeof reservation !== 'object'
						|| typeof reservation.lease !== 'string'
						|| typeof reservation.partition !== 'string') {
						throw new Error('desktop browser bridge returned no reservation')
					}
					const restored = await restoreGuestState()
					const element = document.createElement('webview')
					element.setAttribute('name', reservation.lease)
					element.setAttribute('partition', reservation.partition)
					element.setAttribute('src', 'about:blank#' + reservation.lease)
					const userAgent = cleanUserAgent()
					if (userAgent !== '') element.setAttribute('useragent', userAgent)
					// Fill whatever panel hosts the element; created detached and
					// adopted by the first panel effect that runs (see GuestPanel).
					element.style.width = '100%'
					element.style.height = '100%'
					element.style.display = 'block'
					element.style.border = '0'
					const record = {
						element,
						// 'pending' → replay on first real-origin load; 'done' →
						// snapshots allowed. No snapshot yet? Nothing to replay.
						storageState: restored === null ? 'done' : 'pending',
						timer: 0,
					}
					element.addEventListener('dom-ready', async () => {
						if (userAgent !== '') {
							try { element.setUserAgent(userAgent) } catch (error) { /* attribute already covers most of it */ }
						}
						// Route the guest around the system proxy unless configured
						// otherwise: a blocked proxy exit surfaces as CloudFront 403
						// on chat.deepseek.com, while the direct connection loads.
						try {
							const proxyMode = (await fetch('/api/dsh-webseek/state').then((r) => r.json())).guestProxy
							if (proxyMode === 'system' || proxyMode === 'direct') {
								await element.session.setProxy({ mode: proxyMode })
							}
						} catch (error) { /* keep the default routing if the session API is unavailable */ }
						try { element.loadURL(PAGE_URL) } catch (error) { /* loadURL may be missing on some shells; src fallback below */ }
					}, { once: true })
					element.addEventListener('did-finish-load', () => {
						if (record.storageState !== 'pending') return
						if (!onDeepSeekOrigin(element)) return
						record.storageState = 'restoring'
						Promise.resolve(writeGuestState(element, restored))
							.then(() => { record.storageState = 'done'; element.reload() })
							.catch(() => { record.storageState = 'done' })
					})
					element.addEventListener('did-finish-load', () => {
						if (record.storageState === 'pending' || record.storageState === 'restoring') return
						void saveGuestState(true)
					})
					record.timer = setInterval(() => { void saveGuestState(true) }, SAVE_INTERVAL_MS)
					guest = record
					guestFailure = null
				} catch (error) {
					guestFailure = error instanceof Error ? error.message : String(error)
				} finally {
					acquiring = null
					notifyGuest()
				}
			})()
			return acquiring
		}

		/**
		 * Tear the guest down: stop the snapshot timer, drop the element (a
		 * `<webview>` leaves the document → its guest contents die) and clear
		 * the record. Called when the panel owning the element unmounts.
		 */
		function destroyGuest() {
			if (guest === null) return
			if (guest.timer !== 0) clearInterval(guest.timer)
			try { guest.element.remove() } catch (error) { /* already gone */ }
			guest = null
			notifyGuest()
		}

		/** @returns 'active' | 'acquiring' | 'failed' | 'nobridge' | 'idle'. */
		function guestPhase() {
			if (guest !== null) return 'active'
			if (acquiring !== null) return 'acquiring'
			if (guestFailure !== null) return 'failed'
			if (bridge() === undefined) return 'nobridge'
			return 'idle'
		}

		// --- DeepSeek history import (client side) -----------------------------

		/**
		 * Same-origin JSON fetch INSIDE the guest page. The client page (127.0.0.1)
		 * cannot call chat.deepseek.com's API — cross-origin and credential-less —
		 * but the guest runs on the real origin with the real cookies.
		 * @param element - the live webview.
		 * @param path - API path beginning with /api/v0/.
		 * @returns the parsed JSON body.
		 */
		async function guestFetchJson(element, path) {
			const raw = await element.executeJavaScript(
				'fetch(' + JSON.stringify(path) + ', { headers: { accept: "application/json" } })'
				+ '.then(function (response) { return response.text() })',
			)
			return JSON.parse(raw)
		}

		/** DeepSeek wraps payloads in {code,data{biz_data}}; lists hide under aliases. */
		function unwrap(j, listNames) {
			if (j === null || typeof j !== 'object' || (j.code !== undefined && j.code !== 0)) return null
			const data = typeof j.data === 'object' && j.data !== null ? j.data : j
			const biz = typeof data.biz_data === 'object' && data.biz_data !== null ? data.biz_data : data
			for (const name of listNames) {
				if (Array.isArray(biz[name])) return biz[name]
			}
			return null
		}

		/** Flatten a legacy `content` field: string | blocks array | {text|content}. */
		function legacyText(content) {
			if (content === null || content === undefined) return ''
			if (typeof content === 'string') return content
			if (Array.isArray(content)) {
				return content.map((block) => {
					if (typeof block === 'string') return block
					if (block !== null && typeof block === 'object' && typeof block.text === 'string') return block.text
					if (block !== null && typeof block === 'object' && typeof block.content === 'string') return block.content
					return ''
				}).join('\n')
			}
			if (typeof content === 'object') {
				if (typeof content.text === 'string') return content.text
				if (typeof content.content === 'string') return content.content
			}
			return String(content)
		}

		/** Concatenate one message's fragments of the wanted types (upper case). */
		function fragmentText(message, wanted) {
			const fragments = message !== null && typeof message === 'object' && Array.isArray(message.fragments)
				? message.fragments
				: null
			if (fragments === null) return ''
			return fragments
				.filter((f) => f !== null && typeof f === 'object' && f.content !== undefined && f.content !== null && wanted.has(String(f.type || '').toUpperCase()))
				.map((f) => (typeof f.content === 'string' ? f.content : legacyText(f.content)).trim())
				.filter((text) => text.length > 0)
				.join('\n\n')
		}

		/** `inserted_at` is seconds since the epoch; reject absurd stamps. */
		function messageTime(message, fallback) {
			const seconds = message !== null && typeof message === 'object' ? Number(message.inserted_at) : NaN
			if (!Number.isFinite(seconds) || seconds <= 0) return fallback
			const millis = Math.round(seconds * 1000)
			if (millis < 1000000000000 || millis > Date.now() + 86400000) return fallback
			return millis
		}

		/** One DeepSeek message → `{ role, text, time }` or null for other roles. */
		function toImportableMessage(message) {
			if (message === null || typeof message !== 'object') return null
			const role = String(message.role || '').toLowerCase()
			if (role !== 'user' && role !== 'assistant') return null
			let text
			if (role === 'user') {
				text = fragmentText(message, new Set(['REQUEST'])) || legacyText(message.content)
			} else {
				const thinking = fragmentText(message, new Set(['THINK']))
				const answer = fragmentText(message, new Set(['RESPONSE'])) || legacyText(message.content)
				text = thinking.length > 0
					? (answer.length > 0 ? answer + '\n\n[思考] ' + thinking : '[思考] ' + thinking)
					: answer
			}
			if (typeof text !== 'string' || text.trim().length === 0) return null
			return { role, text, time: messageTime(message, undefined) }
		}

		/** The conversation list: `{ id, title, updatedAt }` rows. */
		function parseConversationList(j) {
			const arr = unwrap(j, ['chat_sessions', 'sessions', 'chat_session_list', 'list'])
			if (arr === null) return null
			return arr.map((s) => ({
				id: typeof s.id === 'string' ? s.id : undefined,
				title: typeof s.title === 'string' ? s.title : '',
				updatedAt: s.updated_at ?? s.updatedAt ?? s.inserted_at ?? null,
			})).filter((s) => s.id !== undefined)
		}

		/** The message list of one conversation, oldest first. */
		function parseHistory(j) {
			const arr = unwrap(j, ['chat_messages', 'messages', 'chat_message_list', 'history', 'message_list'])
			if (arr === null) return null
			return arr.map(toImportableMessage).filter((m) => m !== null)
		}

		/** Client-side import state, shared by the panel. */
		const importState = {
			phase: 'idle', // idle | listing | listed | importing | done | error
			conversations: [],
			selected: new Set(),
			workspaces: [],
			workspaceId: '',
			error: '',
			imported: 0,
			handoffSessionId: '',
		}

		/** Fired whenever the import state moves; the panel re-renders. */
		function notifyImport() {
			window.dispatchEvent(new CustomEvent('dsh-webseek-import'))
		}

		/** Pull the workspace list from the host (once). */
		async function ensureWorkspaces() {
			if (importState.workspaces.length > 0) return
			try {
				const response = await fetch('/api/dsh-webseek/workspaces')
				const body = await response.json()
				importState.workspaces = Array.isArray(body?.workspaces) ? body.workspaces : []
				if (importState.workspaceId === '' && importState.workspaces.length > 0) {
					importState.workspaceId = importState.workspaces[0].id
				}
			} catch (error) {
				importState.error = String(error)
			}
		}

		/** List DeepSeek conversations through the live guest. */
		async function listConversations() {
			if (guest === null) return
			importState.phase = 'listing'
			importState.error = ''
			notifyImport()
			try {
				const raw = await guestFetchJson(guest.element, '/api/v0/chat_session/fetch_page?count=100')
				const conversations = parseConversationList(raw)
				if (conversations === null) throw new Error('响应结构无法解析（可能未登录或接口改版）')
				importState.conversations = conversations
				importState.phase = 'listed'
				await ensureWorkspaces()
			} catch (error) {
				importState.phase = 'error'
				importState.error = error instanceof Error ? error.message : String(error)
			}
			notifyImport()
		}

		/** Import every selected conversation into the chosen workspace. */
		async function importSelected() {
			const ids = [...importState.selected]
			if (ids.length === 0 || guest === null || importState.workspaceId === '') return
			importState.phase = 'importing'
			importState.imported = 0
			importState.error = ''
			notifyImport()
			for (const id of ids) {
				const conversation = importState.conversations.find((c) => c.id === id)
				try {
					const raw = await guestFetchJson(guest.element, '/api/v0/chat/history_messages?chat_session_id=' + encodeURIComponent(id))
					const messages = parseHistory(raw)
					if (messages === null || messages.length === 0) throw new Error('没有可导入的消息')
					const response = await fetch('/api/dsh-webseek/import', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							conversationId: id,
							title: conversation?.title || id,
							messages: messages.map((m) => ({ role: m.role, text: m.text })),
							workspaceId: importState.workspaceId,
						}),
					})
					const body = await response.json()
					if (body?.ok !== true) throw new Error(body?.error ?? 'import failed')
					importState.imported += 1
				} catch (error) {
					importState.error = (conversation?.title || id) + ': ' + (error instanceof Error ? error.message : String(error))
					break
				}
				notifyImport()
			}
			importState.phase = importState.error === '' ? 'done' : 'error'
			notifyImport()
		}

		/** zh/en copy. Flat dotted keys — the locale service indexes one level. */
		const COPY = {
			zh: {
				'type.label': '网页 DeepSeek',
				'card.title': 'dsh-webseek 状态',
				'guest.loading': 'Guest 网页：挂载中…',
				'guest.active': 'Guest 网页：已挂载',
				'guest.failed': 'Guest 网页：挂载失败',
				'guest.nobridge': 'Guest 网页：仅桌面版 App 可用',
				'guest.idle': 'Guest 网页：待挂载',
				'guest.placeholder': '网页加载中…',
				'guide.desc': '内嵌 chat.deepseek.com，支持导入网页会话历史并一键接力',
				'card.hostOk': '宿主服务：在线',
				'card.hostNo': '宿主服务：离线',
				'card.snapshotYes': '登录快照：已保存',
				'card.snapshotNo': '登录快照：暂无',
				'import.title': '导入网页历史',
				'import.list': '拉取会话列表',
				'import.listing': '拉取中…',
				'import.importN': '导入选中',
				'import.importing': '导入中…',
				'import.done': '已导入会话，刷新或重启 DSH 后在左侧会话树可见',
				'import.none': '没有拉到会话',
				'import.workspace': '导入到',
				'import.needDesktop': '导入需要内嵌网页（桌面版 App）',
				'import.handoff': '接力',
				'import.handoffDone': '接力完成，新会话：',
			},
			en: {
				'type.label': 'Web DeepSeek',
				'card.title': 'dsh-webseek status',
				'guest.loading': 'Guest page: acquiring…',
				'guest.active': 'Guest page: live',
				'guest.failed': 'Guest page: acquire failed',
				'guest.nobridge': 'Guest page: desktop app only',
				'guest.idle': 'Guest page: not acquired',
				'guest.placeholder': 'Loading the page…',
				'guide.desc': 'Embedded chat.deepseek.com with history import and one-click hand-off',
				'card.hostOk': 'Host service: online',
				'card.hostNo': 'Host service: offline',
				'card.snapshotYes': 'Login snapshot: saved',
				'card.snapshotNo': 'Login snapshot: none',
				'import.title': 'Import web history',
				'import.list': 'Fetch conversation list',
				'import.listing': 'Fetching…',
				'import.importN': 'Import selected',
				'import.importing': 'Importing…',
				'import.done': 'Imported — reload or restart DSH to see the new sessions',
				'import.none': 'No conversations found',
				'import.workspace': 'Import into',
				'import.needDesktop': 'Import needs the embedded page (desktop app)',
				'import.handoff': 'Hand off',
				'import.handoffDone': 'Handed off, new session: ',
			},
		}

		/**
		 * Resolve a flat dotted key against the zh table as the fallback while
		 * the locale service has not bound this namespace yet.
		 * @param {string} key - dotted i18n key.
		 * @returns {string} the copy, or the key itself when unknown.
		 */
		function fallbackCopy(key) {
			const node = COPY.zh[key]
			return typeof node === 'string' ? node : key
		}

		/** The bound binder, set once the locale service is injected. */
		let localeBinder = null

		/** Translate through the bound locale service with a zh fallback. */
		const t = (key) => {
			try {
				if (localeBinder !== null) {
					const value = localeBinder(key)
					if (typeof value === 'string' && value.length > 0) return value
				}
			} catch { /* fall through to the static table */ }
			return fallbackCopy(key)
		}

		/**
		 * Probe for the native right-sidebar service trio.
		 * @param ctx - client context.
		 * @returns {{tabs: object, sidebar: object, slots: object}} or null.
		 */
		function sidebarServicesOf(ctx) {
			const tabs = ctx.get('sidebarRightTabs')
			const sidebar = ctx.get('sidebarRight')
			const slots = ctx.get('slots')
			if (typeof tabs?.register !== 'function') return null
			if (typeof sidebar?.openTab !== 'function') return null
			if (typeof slots?.register !== 'function' || typeof slots?.inject !== 'function') return null
			return { tabs, sidebar, slots }
		}

		/** Client context captured in apply, for uiWorkspace.openSession. */
		let clientCtx = null

		/** Hand off one conversation into a brand-new real session. */
		async function handoffConversation(conversationId) {
			const conversation = importState.conversations.find((c) => c.id === conversationId)
			importState.phase = 'importing'
			importState.error = ''
			notifyImport()
			try {
				if (guest === null) throw new Error('guest not live')
				await ensureWorkspaces()
				if (importState.workspaceId === '') throw new Error('no workspace selected')
				const raw = await guestFetchJson(guest.element, '/api/v0/chat/history_messages?chat_session_id=' + encodeURIComponent(conversationId))
				const messages = parseHistory(raw)
				if (messages === null || messages.length === 0) throw new Error('没有可接力的消息')
				const response = await fetch('/api/dsh-webseek/handoff', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						conversationId,
						title: conversation?.title || conversationId,
						messages: messages.map((m) => ({ role: m.role, text: m.text })),
						workspaceId: importState.workspaceId,
						template: 'summary',
					}),
				})
				const body = await response.json()
				if (body?.ok !== true) throw new Error(body?.error ?? 'handoff failed')
				importState.handoffSessionId = body.sessionId
				importState.phase = 'done'
				// Jump straight to the new conversation when the UI service is there.
				try {
					const ui = clientCtx?.get?.('uiWorkspace')
					if (typeof ui?.openSession === 'function' && typeof body.sessionId === 'string') {
						ui.openSession(body.sessionId)
					}
				} catch { /* opening is best-effort; the session exists regardless */ }
			} catch (error) {
				importState.phase = 'error'
				importState.error = '接力: ' + (error instanceof Error ? error.message : String(error))
			}
			notifyImport()
		}

		/**
		 * The import section: list → select → workspace → import.
		 * State lives in the module `importState` so the guest (outside React)
		 * and this panel share one source of truth.
		 * @returns React element.
		 */
		function ImportSection() {
			const [, bump] = React.useState(0)
			React.useEffect(() => {
				const onImport = () => bump((n) => n + 1)
				window.addEventListener('dsh-webseek-import', onImport)
				return () => window.removeEventListener('dsh-webseek-import', onImport)
			}, [])
			const state = importState
			const live = guest !== null
			const busy = state.phase === 'listing' || state.phase === 'importing'
			const button = (label, onClick, disabled) => h('button', {
				onClick,
				disabled,
				style: {
					fontSize: 12, padding: '3px 10px', borderRadius: 6, cursor: disabled ? 'default' : 'pointer',
					border: '1px solid var(--dsh-border, #333)', background: 'transparent', color: 'inherit',
				},
			}, label)
			const row = (children, extra) => h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', lineHeight: '22px' }, ...extra }, children)
			return h('div', { style: { marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--dsh-border, #333)' } },
				h('div', { style: { fontWeight: 600, marginBottom: 8 } }, t('import.title')),
				!live
					? h('div', { style: { opacity: 0.7 } }, t('import.needDesktop'))
					: h('div', { style: { display: 'grid', gap: 6 } },
						row([
							button(
								state.phase === 'listing' ? t('import.listing') : state.phase === 'listed' ? t('import.list') : t('import.list'),
								() => { void listConversations() },
								busy,
							),
							state.phase === 'listed' || state.phase === 'importing' || state.phase === 'done'
								? h('span', { style: { opacity: 0.7 } }, String(state.conversations.length))
								: null,
						]),
						(state.phase === 'listed' || state.phase === 'importing' || state.phase === 'done') && state.conversations.length === 0
							? h('div', { style: { opacity: 0.7 } }, t('import.none'))
							: null,
						state.phase === 'listed' || state.phase === 'importing' || state.phase === 'done'
							? h('div', { style: { display: 'grid', gap: 2, maxHeight: 180, overflowY: 'auto' } },
								state.conversations.map((conversation) => h('div', {
									key: conversation.id,
									style: { display: 'flex', gap: 6, alignItems: 'center', lineHeight: '20px' },
								},
									h('label', {
										style: { display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer', flex: 1, minWidth: 0 },
									},
										h('input', {
											type: 'checkbox',
											checked: state.selected.has(conversation.id),
											onChange: (event) => {
												if (event.target.checked) state.selected.add(conversation.id)
												else state.selected.delete(conversation.id)
												bump((n) => n + 1)
											},
										}),
										h('span', {
											style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 },
											title: conversation.title,
										}, conversation.title === '' ? conversation.id : conversation.title),
									),
									button(t('import.handoff'), () => { void handoffConversation(conversation.id) }, busy),
								)))
							: null,
						state.phase === 'listed' || state.phase === 'importing' || state.phase === 'done'
							? row([
								h('span', { style: { opacity: 0.7 } }, t('import.workspace')),
								h('select', {
									value: state.workspaceId,
									onChange: (event) => { state.workspaceId = event.target.value; bump((n) => n + 1) },
									disabled: busy,
									style: { fontSize: 12, padding: '2px 6px', borderRadius: 6, maxWidth: 180 },
								},
									state.workspaces.map((workspace) => h('option', { key: workspace.id, value: workspace.id }, workspace.title)),
								),
								button(
									state.phase === 'importing' ? t('import.importing') : t('import.importN'),
									() => { void importSelected() },
									busy || state.selected.size === 0 || state.workspaceId === '',
								),
							])
							: null,
						state.phase === 'done'
							? h('div', { style: { color: 'var(--dsh-color-success, #2eaa6e)' } },
								t('import.done'),
								importState.handoffSessionId !== ''
									? h('div', null, t('import.handoffDone') + importState.handoffSessionId)
									: null)
							: null,
						state.error !== ''
							? h('div', { style: { color: 'var(--dsh-color-warning, #d99a17)', lineHeight: '18px' } }, state.error)
							: null,
					),
			)
		}

		/**
		 * The tab body. The guest `<webview>` lives INSIDE this panel: the tab
		 * is registered keepMounted, so the host keeps the body in the document
		 * and merely hides it (closed sidebar → slid off-screen + visibility,
		 * tab/session switch → hidden attribute) — the webview follows along
		 * with zero positioning work. Unmounting the body (tab closed, session
		 * retired, plugin unloaded) destroys the guest; the next panel
		 * re-acquires. Status rows and the import section dock under the page.
		 * @returns React element.
		 */
		function GuestPanel() {
			const hostRef = React.useRef(null)
			const [phase, setPhase] = React.useState(() => guestPhase())
			const [host, setHost] = React.useState(null)
			// Acquire the guest and follow its lifecycle.
			React.useEffect(() => {
				void ensureGuest()
				const onGuest = () => setPhase(guestPhase())
				window.addEventListener('dsh-webseek-guest', onGuest)
				return () => window.removeEventListener('dsh-webseek-guest', onGuest)
			}, [])
			// Adopt the guest element once it exists (first panel to run while
			// the element is unattached wins; later panels leave it alone).
			React.useEffect(() => {
				const hostEl = hostRef.current
				if (hostEl === null || guest === null) return
				if (guest.element.parentNode === hostEl || guest.element.isConnected) return
				hostEl.replaceChildren(guest.element)
			}, [phase])
			// This body's unmount is the guest's death (the keepMounted host
			// never unmounts for a mere hide), so cleanup owns the teardown.
			React.useEffect(() => () => {
				if (guest !== null && guest.element.parentNode === hostRef.current) destroyGuest()
			}, [])
			React.useEffect(() => {
				let alive = true
				fetch('/api/dsh-webseek/state')
					.then((response) => response.json())
					.then((body) => { if (alive) setHost(body) })
					.catch(() => { if (alive) setHost(null) })
				return () => { alive = false }
			}, [phase])
			const guestRow = {
				active: 'guest.active',
				acquiring: 'guest.loading',
				failed: 'guest.failed',
				nobridge: 'guest.nobridge',
				idle: 'guest.idle',
			}[phase] ?? 'guest.idle'
			const guestOk = phase === 'active'
			const guestWarn = phase === 'acquiring'
			const hostOk = host !== null && host.ok === true
			const row = (ok, warn, yes, warnText, no) => h('div', {
				style: { display: 'flex', gap: 8, alignItems: 'center', lineHeight: '20px' },
			},
				h('span', {
					'aria-hidden': 'true',
					style: {
						width: 7, height: 7, borderRadius: '50%', flex: 'none',
						background: ok
							? 'var(--dsh-color-success, #2eaa6e)'
							: warn
								? 'var(--dsh-color-info, #4a90d9)'
								: 'var(--dsh-color-warning, #d99a17)',
					},
				}),
				h('span', null, ok ? yes : warn ? warnText : no),
			)
			return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', boxSizing: 'border-box', fontSize: 12, opacity: 0.92 } },
				h('div', { ref: hostRef, style: { flex: 1, minHeight: 0, position: 'relative', background: 'var(--dsh-bg, #141414)' } },
					guest !== null && guest.element.parentNode === hostRef.current
						? null
						: h('div', {
							style: {
								position: 'absolute', inset: 0, display: 'flex',
								alignItems: 'center', justifyContent: 'center',
								color: 'var(--dsh-alias-label-tertiary, #8a8a8a)',
							},
						}, t('guest.placeholder')),
				),
				h('div', {
					style: {
						flex: 'none', maxHeight: '45%', overflowY: 'auto', boxSizing: 'border-box',
						borderTop: '0.5px solid var(--dsh-alias-border-l3, rgba(127,127,127,0.25))',
						padding: '8px 12px 10px',
					},
				},
					h('div', { style: { display: 'grid', gap: 2 } },
						row(guestOk, guestWarn, t('guest.active'), t('guest.loading'), t(guestRow)),
						row(hostOk, false, t('card.hostOk'), '', t('card.hostNo')),
						hostOk
							? row(host.sessionSaved === true, false, t('card.snapshotYes'), '', t('card.snapshotNo'))
							: null,
						phase === 'failed' && guestFailure !== null
							? h('div', { style: { opacity: 0.7, lineHeight: '16px' } }, guestFailure)
							: null,
					),
					h(ImportSection, null),
				),
			)
		}

		/**
		 * Browser-half activation.
		 *
		 * ## Why nothing UI-shaped is in the module `inject`
		 *
		 * cordis has no optional-dependency form: every key of an `inject`
		 * descriptor is a requirement, and a key the host does not implement
		 * parks this plugin's fiber — which fails the whole web boot instead
		 * of skipping this plugin (dsh-sidebar-qa documents the same trap).
		 * So the module inject stays empty and every UI service is probed
		 * with `ctx.get` inside apply; `internal/service` events re-run the
		 * install whenever a service lands later.
		 * @param ctx - client context (slots, locale, sidebarRight, sidebarRightTabs).
		 */
		function apply(ctx) {
			console.info('[dsh-webseek] apply; ctx keys:', Object.keys(ctx).join(','))
			clientCtx = ctx

			// Locale is a data service with a real implementation: ctx.inject
			// is the sanctioned way to wait for it inside apply.
			ctx.inject(['locale'], (localeCtx) => {
				try {
					localeCtx.locale.register(NS, 'zh', COPY.zh)
					localeCtx.locale.register(NS, 'en', COPY.en)
					localeBinder = localeCtx.locale.bind(NS)
				} catch (error) {
					console.warn('[dsh-webseek] locale registration failed:', error)
				}
				console.info('[dsh-webseek] locale bound; label =', t('type.label'))
			})

			// The right-sidebar trio is probed, never injected. Register the
			// tab type, its body and its chip title as soon as all three exist.
			let settled = false
			const installIfPossible = () => {
				if (settled) return
				const services = sidebarServicesOf(ctx)
				if (services === null) return
				settled = true
				const { tabs, slots } = services
				const disposers = []
				disposers.push(tabs.register({
					id: TAB_ID,
					kind: TAB_KIND,
					priority: 'extension',
					title: () => t('type.label'),
					guide: [{
						id: 'webseek',
						order: 30,
						title: () => t('type.label'),
						description: () => t('guide.desc'),
					}],
					// The future guest webview must survive tab switches; keep
					// the body mounted from day one so the contract is settled.
					keepMounted: true,
				}))
				disposers.push(slots.inject('sidebar.right.pane.tab', () => slots.register({
					name: 'sidebar.right.pane.tab',
					key: TAB_ID,
				}, GuestPanel)))
				disposers.push(slots.inject('sidebar.right.pane.tab.title', () => slots.register({
					name: 'sidebar.right.pane.tab.title',
					key: TAB_ID,
				}, () => t('type.label'))))
				ctx.effect(() => () => {
					for (const dispose of disposers.reverse()) dispose()
					settled = false
				}, 'webseek: sidebar registrations')
				console.info('[dsh-webseek] sidebarRightTabs registered')
			}
			ctx.effect(() => {
				const off = ctx.on('internal/service', () => installIfPossible())
				installIfPossible()
				return off
			}, 'webseek: sidebar service watch')
		}

		const inject = []

		exports.apply = apply
		exports.inject = inject
		return module.exports
	},
})
