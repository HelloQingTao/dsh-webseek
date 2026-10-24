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

		/** zh/en copy. Keys must stay aligned across both tables. */
		const COPY = {
			zh: {
				type: { label: '网页 DeepSeek' },
				card: {
					title: 'dsh-webseek 状态',
					guestOk: '桌面 guest 通道：可用',
					guestNo: '桌面 guest 通道：不可用（需在桌面版 App 中使用）',
					hostOk: '宿主服务：在线',
					hostNo: '宿主服务：离线',
					snapshotYes: '登录快照：已保存',
					snapshotNo: '登录快照：暂无',
					footer: '骨架版：内嵌面板、历史导入与总结接力将在后续步骤逐个点亮。',
				},
			},
			en: {
				type: { label: 'Web DeepSeek' },
				card: {
					title: 'dsh-webseek status',
					guestOk: 'Desktop guest channel: available',
					guestNo: 'Desktop guest channel: unavailable (use the desktop app)',
					hostOk: 'Host service: online',
					hostNo: 'Host service: offline',
					snapshotYes: 'Login snapshot: saved',
					snapshotNo: 'Login snapshot: none',
					footer: 'Skeleton build: the embedded panel, import and hand-off land in later steps.',
				},
			},
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
			const t = COPY.zh.card
			const guestOk = bridge() !== undefined
			const hostOk = host !== null && host.ok === true
			const row = (label, ok, yes, no) => h('div', {
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
				h('div', { style: { fontWeight: 600, marginBottom: 10 } }, t.title),
				h('div', { style: { display: 'grid', gap: 4 } },
					row('guest', guestOk, t.guestOk, t.guestNo),
					row('host', hostOk, t.hostOk, t.hostNo),
					hostOk
						? row('snap', host.sessionSaved === true, t.snapshotYes, t.snapshotNo)
						: null,
				),
				h('div', { style: { marginTop: 14, opacity: 0.65, lineHeight: '18px' } }, t.footer),
			)
		}

		/**
		 * Browser-half activation.
		 * @param ctx - client context (slots, locale, sidebarRight, sidebarRightTabs).
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, COPY), 'webseek: copy')
			const t = ctx.locale.bind(NS)
			ctx.effect(() => ctx.sidebarRightTabs.register({
				id: TAB_ID,
				kind: TAB_KIND,
				title: () => t('type.label'),
				// The future guest webview must survive tab switches; keep the body
				// mounted from day one so the contract is settled early.
				keepMounted: true,
			}), 'webseek: tab type')
			ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
				name: 'sidebar.right.pane.tab',
				key: TAB_ID,
				locale: NS,
				inject: (sessionId) => ({ sessionId }),
			}, StatusCard)), 'webseek: body')
		}

		const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs']

		exports.apply = apply
		exports.inject = inject
		return module.exports
	},
})
