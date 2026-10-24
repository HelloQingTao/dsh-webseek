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

		/** Attribute marking this plugin's overlay container on document.body. */
		const OVERLAY_ATTR = 'data-dsh-webseek-overlay'

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

		/** Inject the overlay stylesheet once. */
		function ensureStyle() {
			if (document.getElementById('dsh-webseek-style') !== null) return
			const style = document.createElement('style')
			style.id = 'dsh-webseek-style'
			style.textContent = '[' + OVERLAY_ATTR + ']{position:fixed;z-index:40;background:var(--dsh-bg,#141414)}'
			document.head.appendChild(style)
		}

		/**
		 * The guest's persistent home at the document root. It lives OUTSIDE the
		 * React tree because a `<webview>` is destroyed when it leaves the
		 * document — if the slot owned it, every tab switch would tear the page
		 * down. Tab bodies only measure their rectangle; the container is
		 * positioned onto it and parked (display:none) when hidden.
		 * @returns the container element.
		 */
		function overlayContainer() {
			ensureStyle()
			const existing = document.querySelector('[' + OVERLAY_ATTR + ']')
			if (existing !== null) return existing
			const box = document.createElement('div')
			box.setAttribute(OVERLAY_ATTR, '')
			box.style.display = 'none'
			document.body.appendChild(box)
			return box
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
					const record = {
						element,
						container: overlayContainer(),
						// 'pending' → replay on first real-origin load; 'done' →
						// snapshots allowed. No snapshot yet? Nothing to replay.
						storageState: restored === null ? 'done' : 'pending',
						timer: 0,
					}
					element.addEventListener('dom-ready', () => {
						if (userAgent !== '') {
							try { element.setUserAgent(userAgent) } catch (error) { /* attribute already covers most of it */ }
						}
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
					record.container.appendChild(element)
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

		/** @returns 'active' | 'acquiring' | 'failed' | 'nobridge' | 'idle'. */
		function guestPhase() {
			if (guest !== null) return 'active'
			if (acquiring !== null) return 'acquiring'
			if (guestFailure !== null) return 'failed'
			if (bridge() === undefined) return 'nobridge'
			return 'idle'
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
				'card.hostOk': '宿主服务：在线',
				'card.hostNo': '宿主服务：离线',
				'card.snapshotYes': '登录快照：已保存',
				'card.snapshotNo': '登录快照：暂无',
				'card.footer': '骨架版：内嵌面板、历史导入与总结接力将在后续步骤逐个点亮。',
			},
			en: {
				'type.label': 'Web DeepSeek',
				'card.title': 'dsh-webseek status',
				'guest.loading': 'Guest page: acquiring…',
				'guest.active': 'Guest page: live',
				'guest.failed': 'Guest page: acquire failed',
				'guest.nobridge': 'Guest page: desktop app only',
				'guest.idle': 'Guest page: not acquired',
				'card.hostOk': 'Host service: online',
				'card.hostNo': 'Host service: offline',
				'card.snapshotYes': 'Login snapshot: saved',
				'card.snapshotNo': 'Login snapshot: none',
				'card.footer': 'Skeleton build: the embedded panel, import and hand-off land in later steps.',
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

		/**
		 * The tab body. Mounts the guest (desktop only), positions the overlay
		 * container onto its own rectangle, and reports channel + host state.
		 * The real conversation UI replaces the status list in later steps.
		 * @returns React element.
		 */
		function GuestPanel() {
			const panelRef = React.useRef(null)
			const [phase, setPhase] = React.useState(() => guestPhase())
			const [host, setHost] = React.useState(null)
			// Mount the guest once and follow its lifecycle.
			React.useEffect(() => {
				void ensureGuest()
				const onGuest = () => setPhase(guestPhase())
				window.addEventListener('dsh-webseek-guest', onGuest)
				return () => window.removeEventListener('dsh-webseek-guest', onGuest)
			}, [])
			React.useEffect(() => {
				let alive = true
				fetch('/api/dsh-webseek/state')
					.then((response) => response.json())
					.then((body) => { if (alive) setHost(body) })
					.catch(() => { if (alive) setHost(null) })
				return () => { alive = false }
			}, [phase])
			// Size the persistent overlay onto this panel's rectangle. A few
			// frames of rAF cover the sidebar's slide-in animation; a resize
			// listener keeps it glued afterwards.
			React.useEffect(() => {
				const sync = () => {
					const panel = panelRef.current
					if (panel === null) return
					const rect = panel.getBoundingClientRect()
					const container = overlayContainer()
					container.style.display = guest === null ? 'none' : 'block'
					container.style.left = `${rect.left}px`
					container.style.top = `${rect.top}px`
					container.style.width = `${rect.width}px`
					container.style.height = `${rect.height}px`
				}
				let frames = 0
				let raf = 0
				const tick = () => { sync(); if (frames++ < 60) raf = requestAnimationFrame(tick) }
				raf = requestAnimationFrame(tick)
				window.addEventListener('resize', sync)
				return () => {
					cancelAnimationFrame(raf)
					window.removeEventListener('resize', sync)
					const container = guest !== null ? guest.container : null
					if (container !== null) container.style.display = 'none'
				}
			}, [])
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
				style: { display: 'flex', gap: 8, alignItems: 'center', lineHeight: '22px' },
			},
				h('span', {
					'aria-hidden': 'true',
					style: {
						width: 8, height: 8, borderRadius: '50%', flex: 'none',
						background: ok
							? 'var(--dsh-color-success, #2eaa6e)'
							: warn
								? 'var(--dsh-color-info, #4a90d9)'
								: 'var(--dsh-color-warning, #d99a17)',
					},
				}),
				h('span', null, ok ? yes : warn ? warnText : no),
			)
			return h('div', { ref: panelRef, style: { padding: '16px 16px 24px', fontSize: 12, opacity: 0.92, height: '100%', boxSizing: 'border-box', overflowY: 'auto' } },
				h('div', { style: { fontWeight: 600, marginBottom: 10 } }, t('card.title')),
				h('div', { style: { display: 'grid', gap: 4 } },
					row(guestOk, guestWarn, t('guest.active'), t('guest.loading'), t(guestRow)),
					row(hostOk, false, t('card.hostOk'), '', t('card.hostNo')),
					hostOk
						? row(host.sessionSaved === true, false, t('card.snapshotYes'), '', t('card.snapshotNo'))
						: null,
					phase === 'failed' && guestFailure !== null
						? h('div', { style: { opacity: 0.7, lineHeight: '18px' } }, guestFailure)
						: null,
				),
				h('div', { style: { marginTop: 14, opacity: 0.65, lineHeight: '18px' } }, t('card.footer')),
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
						description: () => t('card.footer'),
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
