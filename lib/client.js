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

		/** zh/en copy. Flat dotted keys — the locale service indexes one level. */
		const COPY = {
			zh: {
				'type.label': '网页 DeepSeek',
				'card.title': 'dsh-webseek 状态',
				'card.guestOk': '桌面 guest 通道：可用',
				'card.guestNo': '桌面 guest 通道：不可用（需在桌面版 App 中使用）',
				'card.hostOk': '宿主服务：在线',
				'card.hostNo': '宿主服务：离线',
				'card.snapshotYes': '登录快照：已保存',
				'card.snapshotNo': '登录快照：暂无',
				'card.footer': '骨架版：内嵌面板、历史导入与总结接力将在后续步骤逐个点亮。',
			},
			en: {
				'type.label': 'Web DeepSeek',
				'card.title': 'dsh-webseek status',
				'card.guestOk': 'Desktop guest channel: available',
				'card.guestNo': 'Desktop guest channel: unavailable (use the desktop app)',
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
		 * The tab body. Reports channel availability and the host state; the
		 * real guest panel replaces this in step 4.
		 * @returns React element.
		 */
		function StatusCard() {
			const [host, setHost] = React.useState(null)
			React.useEffect(() => {
				let alive = true
				fetch('/api/dsh-webseek/state')
					.then((response) => response.json())
					.then((body) => { if (alive) setHost(body) })
					.catch(() => { if (alive) setHost(null) })
				return () => { alive = false }
			}, [])
			const t = fallbackCopy
			const guestOk = bridge() !== undefined
			const hostOk = host !== null && host.ok === true
			const row = (ok, yes, no) => h('div', {
				style: { display: 'flex', gap: 8, alignItems: 'center', lineHeight: '22px' },
			},
				h('span', {
					'aria-hidden': 'true',
					style: {
						width: 8, height: 8, borderRadius: '50%', flex: 'none',
						background: ok ? 'var(--dsh-color-success, #2eaa6e)' : 'var(--dsh-color-warning, #d99a17)',
					},
				}),
				h('span', null, ok ? yes : no),
			)
			return h('div', { style: { padding: '16px 16px 24px', fontSize: 12, opacity: 0.9 } },
				h('div', { style: { fontWeight: 600, marginBottom: 10 } }, t('card.title')),
				h('div', { style: { display: 'grid', gap: 4 } },
					row(guestOk, t('card.guestOk'), t('card.guestNo')),
					row(hostOk, t('card.hostOk'), t('card.hostNo')),
					hostOk
						? row(host.sessionSaved === true, t('card.snapshotYes'), t('card.snapshotNo'))
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
				}, StatusCard)))
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
