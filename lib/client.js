/**
 * dsh-webseek — browser half.
 *
 * The plugin's whole job now: a public DeepSeek **share link** becomes a DSH
 * session. The entry point is one icon in the left sidebar — on the row that
 * carries the workspace section header (search / view options / add
 * workspace) — which opens a small dialog: paste the share link, pick the
 * target workspace, import.
 *
 * ## Why the icon is mounted by hand
 *
 * DSH declares no slot for that header row: the sidebar's plugin-facing
 * surfaces are `sidebar.footer.action` (the icon row above Settings),
 * `sidebar.panellist` (the global panel icons) and the session-row slots. The
 * workspace header is rendered inside the single-owner `sidebar.workspaces`
 * region, so nothing can be added to it through a slot.
 *
 * The button therefore lives in a React root of our own, placed into the row
 * directly. Both the row and the fallback are found through **stable hooks**:
 * the slot system stamps `data-slot` on what it renders, so the region is
 * `[data-slot="sidebar.workspaces"]` and the fallback is
 * `[data-slot="sidebar.footer.action"]` — no CSS-module class names, which
 * DSH re-hashes on every build.
 *
 * The dialog gets a second root on `<body>`: it must escape every transformed
 * ancestor (the sidebar is animated), and `position: fixed` inside a
 * transformed ancestor would be positioned against that ancestor instead of
 * the window.
 */
window.__ModuleLoader__.load({
	id: 'dsh-webseek',
	factory: (require) => {
		const module = { exports: {} }
		const exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const React = require('react')
		const ReactDOM = require('react-dom')
		const h = React.createElement

		/** `createRoot` lives in 'react-dom/client' (React 18); older bundles expose it on 'react-dom'. */
		let createRoot = null
		try {
			createRoot = require('react-dom/client').createRoot
		} catch (error) {
			createRoot = ReactDOM.createRoot
		}

		/** Locale namespace, and the i18n key for this plugin's copy. */
		const NS = 'dsh-webseek'

		/** The slot the workspace region is rendered into. */
		const WORKSPACE_REGION = '[data-slot="sidebar.workspaces"]'

		/** The plugin row above Settings — where the icon lands if the header row is gone. */
		const FOOTER_ACTION = '[data-slot="sidebar.footer.action"]'

		/** The class-name suffix of the workspace section header row. */
		const SECTION_HEADER = '[class*="_sectionHeader"]'

		/** The id of the workspace field's label, so the picker can name itself. */
		const WORKSPACE_LABEL_ID = 'dsh-webseek-workspace-label'

		/** The version shown in the dialog footer; a test keeps it equal to package.json. */
		const VERSION = '0.2.0'

		/** Where the footer links point. */
		const REPO_URL = 'https://github.com/HelloQingTao/dsh-webseek'
		const ISSUES_URL = REPO_URL + '/issues'

		/** zh/en copy. Flat dotted keys — the locale service indexes one level. */
		const COPY = {
			zh: {
				'entry.title': '导入网页会话',
				'dialog.title': '导入网页会话',
				'dialog.link': '网页会话分享链接',
				'dialog.linkPlaceholder': 'https://chat.deepseek.com/share/xxxxxxxx',
				'dialog.workspace': '导入到工作区',
				'dialog.workspaceLoading': '正在读取工作区…',
				'dialog.workspaceEmpty': '没有可用工作区',
				'dialog.submit': '导入',
				'dialog.importing': '导入中…',
				'dialog.cancel': '取消',
				'dialog.done': '已导入到工作区',
				'dialog.already': '这个分享之前已经导入过了',
				'dialog.treeHint': '点「打开会话」直接跳过去；左栏那一行也可以手动点',
				'dialog.open': '打开会话',
				'dialog.opening': '正在打开…',
				'dialog.openTimeout': '左栏还没出现这一条，刷新一下 DSH 页面再试',
				'footer.feedback': '欢迎提 Issue 和建议',
				'footer.check': '检查更新',
				'footer.checking': '检查中…',
				'footer.latest': '已是最新',
				'footer.updateAvailable': '有新版本',
				'footer.notPublished': '尚未发布',
				'footer.checkFailed': '检查失败',
				'error.link': '链接格式不对：需要 chat.deepseek.com/share/… 或直接是分享 id',
				'error.workspace': '工作区不可用',
				'error.rate': '上游限流了，稍后再试一次',
				'error.gone': '分享不存在或已失效',
				'error.empty': '这个分享里没有可导入的内容',
				'error.upstream': '网页接口没有返回预期内容（可能改版了）',
				'error.timeout': '请求超时',
				'error.network': '网络不通',
				'error.large': '这个分享太大了',
				'error.unavailable': '会话服务不可用',
				'error.unknown': '导入失败',
			},
			en: {
				'entry.title': 'Import web conversation',
				'dialog.title': 'Import web conversation',
				'dialog.link': 'Share link',
				'dialog.linkPlaceholder': 'https://chat.deepseek.com/share/xxxxxxxx',
				'dialog.workspace': 'Import into workspace',
				'dialog.workspaceEmpty': 'No workspace available',
				'dialog.submit': 'Import',
				'dialog.importing': 'Importing…',
				'dialog.cancel': 'Cancel',
				'dialog.done': 'Imported into workspace',
				'dialog.already': 'This share was imported before',
				'dialog.treeHint': 'Use “Open conversation” to jump to it; the new sidebar row works too',
				'dialog.open': 'Open conversation',
				'dialog.opening': 'Opening…',
				'dialog.openTimeout': 'The row is not in the sidebar yet — refresh the page and try again',
				'footer.feedback': 'Issues & suggestions welcome',
				'footer.check': 'Check for updates',
				'footer.checking': 'Checking…',
				'footer.latest': 'Up to date',
				'footer.updateAvailable': 'New version',
				'footer.notPublished': 'Not published yet',
				'footer.checkFailed': 'Check failed',
				'error.link': 'Bad link: expected chat.deepseek.com/share/… or a bare share id',
				'error.workspace': 'Workspace unavailable',
				'error.rate': 'Upstream rate limit — try again later',
				'error.gone': 'The share is gone or was deleted',
				'error.empty': 'That share has nothing to import',
				'error.upstream': 'The web API did not answer as expected',
				'error.timeout': 'The request timed out',
				'error.network': 'Network unreachable',
				'error.large': 'That share is too large',
				'error.unavailable': 'Session services unavailable',
				'error.unknown': 'Import failed',
			},
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
			const node = COPY.zh[key]
			return typeof node === 'string' ? node : key
		}

		/**
		 * Map a host error code onto the copy key that explains it.
		 * @param {unknown} code - the host's `error` field.
		 * @returns {string} a copy key.
		 */
		function errorKey(code) {
			const text = typeof code === 'string' ? code : ''
			if (text === 'invalid share link') return 'error.link'
			if (text === 'unknown workspace' || text === 'workspaceRegistry unavailable') return 'error.workspace'
			if (text === 'rate-limited') return 'error.rate'
			if (text === 'not-found') return 'error.gone'
			if (text === 'empty') return 'error.empty'
			if (text === 'bad-response') return 'error.upstream'
			if (text === 'timeout') return 'error.timeout'
			if (text === 'network') return 'error.network'
			if (text === 'too-large') return 'error.large'
			if (text === 'session services unavailable') return 'error.unavailable'
			return 'error.unknown'
		}

		/** The plugin's own styles, injected once. */
		const STYLE_ID = 'dsh-webseek-style'

		/**
		 * Put the plugin stylesheet into the document (once).
		 */
		function ensureStyle() {
			if (typeof document === 'undefined' || document.getElementById(STYLE_ID) !== null) return
			const style = document.createElement('style')
			style.id = STYLE_ID
			// Every colour comes from DSH's own design tokens (`--dsw-*`), so the
			// dialog follows the active theme — light or dark — without a second
			// stylesheet. The fallbacks only matter when the plugin runs outside
			// the shell.
			style.textContent = [
				'.dsh-webseek-entry{display:contents}',
				'.dsh-webseek-btn{width:28px;height:28px;flex:none;display:inline-flex;align-items:center;justify-content:center;',
				'border:none;border-radius:var(--dsw-radius-sm,8px);background:transparent;',
				'color:var(--dsw-alias-label-secondary,#c9c9cf);cursor:pointer;padding:0}',
				'.dsh-webseek-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16))}',
				'.dsh-webseek-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#5b8cff))}',
				'.dsh-webseek-btn:disabled{opacity:.45;cursor:default}',
				// Overlay + panel, the way the shell's own modal layer does it.
				'.dsh-webseek-mask{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;',
				'background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.4));backdrop-filter:var(--dsw-mask-blur,none)}',
				'.dsh-webseek-modal{width:min(380px,100%);box-sizing:border-box;padding:24px;',
				'border-radius:var(--dsw-radius-panel,28px);overflow:visible;',
				'--dsw-webseek-panel-base:var(--dsh-dream-skin-modal-base,var(--dsw-alias-bg-layer-2,#1d1d20));',
				'--dsw-webseek-panel-fill:var(--dsh-dream-skin-modal-fill,100%);',
				'background:var(--dsw-alias-bg-layer-2,#1d1d20);',
				'background:color-mix(in srgb,var(--dsw-webseek-panel-base) var(--dsw-webseek-panel-fill),transparent);',
				'-webkit-backdrop-filter:blur(var(--dsh-dream-skin-glass-blur,0px)) var(--dsh-dream-skin-glass-tone,none);',
				'backdrop-filter:blur(var(--dsh-dream-skin-glass-blur,0px)) var(--dsh-dream-skin-glass-tone,none);',
				'color:var(--dsw-alias-label-primary,#ececf0);box-shadow:var(--dsw-elevation-prominent,0 12px 40px rgba(0,0,0,.35))}',
				'.dsh-webseek-modal-title{font-size:16px;line-height:24px;font-weight:600;margin-bottom:20px;',
				'color:var(--dsw-alias-label-primary,#ececf0)}',
				'.dsh-webseek-field{display:block;margin-bottom:20px;font-size:13px;font-weight:500;line-height:1.5;',
				'color:var(--dsw-alias-label-primary,#ececf0)}',
				// The input shell: one bordered surface, the label sits outside it.
				'.dsh-webseek-input{display:flex;align-items:center;gap:6px;height:32px;padding:0 8px;margin-top:6px;',
				'box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4,rgba(255,255,255,.2));',
				'border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1,#202024)}',
				'.dsh-webseek-input:focus-within{border-color:var(--dsw-alias-state-business-primary,#5b8cff)}',
				'.dsh-webseek-input input{flex:1;min-width:0;border:none;outline:none;background:transparent;',
				'font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary,#ececf0)}',
				'.dsh-webseek-input input::placeholder{color:var(--dsw-alias-label-dimmed,#8a8a8a)}',
				'.dsh-webseek-input input[readonly]{color:var(--dsw-alias-label-tertiary,#8a8a8a)}',
				// The workspace picker: a trigger that looks like the input, and
				// the shell's own menu surface underneath it.
				'.dsh-webseek-picker{position:relative;margin-top:6px}',
				'.dsh-webseek-field-btn{width:100%;box-sizing:border-box;display:flex;align-items:center;gap:8px;',
				'height:32px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l4,rgba(255,255,255,.2));',
				'border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1,#202024);',
				'color:var(--dsw-alias-label-primary,#ececf0);font-size:14px;line-height:22px;cursor:pointer;text-align:left}',
				'.dsh-webseek-field-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16))}',
				'.dsh-webseek-field-btn:disabled{cursor:not-allowed;opacity:.4}',
				'.dsh-webseek-field-value{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
				'.dsh-webseek-field-btn svg{flex:none;opacity:.6}',
				'.dsh-webseek-menu{position:fixed;z-index:1100;',
				'max-height:240px;overflow-y:auto;box-sizing:border-box;padding:4px;',
				'display:flex;flex-direction:column;border:0;border-radius:var(--dsw-radius-lg,16px);',
				'--dsw-webseek-menu-base:var(--dsh-dream-skin-modal-base,var(--dsw-specific-menu,rgba(48,49,54,.98)));',
				'--dsw-webseek-menu-fill:var(--dsh-dream-skin-modal-fill,94%);',
				'background:var(--dsw-specific-menu,rgba(48,49,54,.98));',
				'background:color-mix(in srgb,var(--dsw-webseek-menu-base) var(--dsw-webseek-menu-fill),transparent);',
				'backdrop-filter:var(--dsw-menu-backdrop-filter,blur(40px) saturate(150%));',
				'box-shadow:var(--dsw-elevation-prominent,0 12px 40px rgba(0,0,0,.35));',
				'--dsw-elevation-stroke-color:var(--dsw-alias-border-l1,rgba(255,255,255,.1));',
				'--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2,rgba(255,255,255,.2));',
				'--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2,rgba(255,255,255,.3))}',
				'.dsh-webseek-menu-item{display:flex;align-items:center;gap:6px;width:100%;min-height:34px;padding:6px 8px;',
				'border:none;border-radius:var(--dsw-radius-md,12px);background:transparent;cursor:pointer;',
				'font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,#ececf0);text-align:left}',
				'.dsh-webseek-menu-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16))}',
				'.dsh-webseek-menu-item.selected{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16))}',
				'.dsh-webseek-menu-item svg{flex:none}',
				'.dsh-webseek-menu-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
				'.dsh-webseek-error{font-size:13px;line-height:20px;color:var(--dsw-alias-state-error-primary,#e05a5a);margin:0 0 12px}',
				'.dsh-webseek-note{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#c9c9cf);margin:0 0 12px}',
				'.dsh-webseek-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}',
				'.dsh-webseek-dialog-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;',
				'gap:4px;border:none;border-radius:var(--dsw-radius-md,12px);cursor:pointer;font-size:14px;line-height:22px;',
				'padding:0 14px;background:transparent;color:var(--dsw-alias-label-primary,#ececf0)}',
				'.dsh-webseek-dialog-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16))}',
				'.dsh-webseek-dialog-btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active,rgba(128,128,128,.24))}',
				'.dsh-webseek-dialog-btn:disabled{cursor:not-allowed;opacity:.4}',
				'.dsh-webseek-dialog-btn.primary{background:var(--dsw-alias-button-primary-fill,#5b8cff);',
				'color:var(--dsw-alias-label-primary-foreground,#fff)}',
				'.dsh-webseek-dialog-btn.primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#4d7ff0)}',
				// Footer: project links + version + a live update check, kept quiet.
				'.dsh-webseek-footer{margin-top:20px;padding-top:14px;display:flex;align-items:center;justify-content:space-between;',
				'gap:10px 12px;flex-wrap:wrap;border-top:.5px solid var(--dsw-alias-border-l3,rgba(255,255,255,.12));',
				'font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#c9c9cf)}',
				'.dsh-webseek-footer-links{display:flex;align-items:center;gap:8px;min-width:0}',
				'.dsh-webseek-footer-link{color:var(--dsw-alias-label-secondary,#c9c9cf);text-decoration:none;cursor:pointer}',
				'.dsh-webseek-footer-link:hover{color:var(--dsw-alias-state-business-primary,#5b8cff);text-decoration:underline}',
				'.dsh-webseek-footer-dot{opacity:.5}',
				'.dsh-webseek-footer-meta{display:flex;align-items:center;gap:8px;flex:none}',
				'.dsh-webseek-footer-version{color:var(--dsw-alias-label-dimmed,#8a8a8a);font-variant-numeric:tabular-nums}',
				'.dsh-webseek-linkbtn{border:none;background:transparent;padding:0;cursor:pointer;font:inherit;',
				'color:var(--dsw-alias-label-secondary,#c9c9cf)}',
				'.dsh-webseek-linkbtn:hover:not(:disabled){color:var(--dsw-alias-state-business-primary,#5b8cff);text-decoration:underline}',
				'.dsh-webseek-linkbtn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#5b8cff));outline-offset:2px}',
				'.dsh-webseek-linkbtn:disabled{cursor:default;opacity:.6}',
				'.dsh-webseek-footer-status{white-space:nowrap}',
				'.dsh-webseek-footer-status.ok{color:var(--dsw-alias-state-success-primary,#3ba55d)}',
				'.dsh-webseek-footer-status.update{color:var(--dsw-alias-state-business-primary,#5b8cff)}',
				'.dsh-webseek-footer-status.error{color:var(--dsw-alias-state-error-primary,#e05a5a)}',
			].join('')
			document.head.appendChild(style)
		}

		/** The entry icon: an arrow dropping into a tray. */
		function EntryIcon() {
			return h('svg', {
				width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none',
				'aria-hidden': 'true',
			},
				h('path', {
					d: 'M8 1.8v7.2M8 9 5.2 6.2M8 9l2.8-2.8M2.6 10.6v1.8a1.4 1.4 0 0 0 1.4 1.4h8a1.4 1.4 0 0 0 1.4-1.4v-1.8',
					stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
				}),
			)
		}

		/** The chevron of the workspace trigger. */
		function ChevronIcon() {
			return h('svg', {
				width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true',
			},
				h('path', {
					d: 'M4 6.5 8 10.5l4-4',
					stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
				}),
			)
		}

		/** The check mark of the selected workspace. */
		function CheckIcon() {
			return h('svg', {
				width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true',
			},
				h('path', {
					d: 'M3.5 8.5 6.5 11.5 12.5 4.5',
					stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
				}),
			)
		}

		/**
		 * The workspace picker: a field-shaped trigger with the shell's menu
		 * below it.
		 *
		 * A native `<select>` cannot wear the shell's theme (its popup is
		 * drawn by the OS), so the dropdown is built from the same menu
		 * surface, menu item and hover tokens the shell uses.
		 * @param props - `{ workspaces, value, onChange }`.
		 * @returns React element.
		 */
		function WorkspacePicker({ workspaces, value, onChange, labelId }) {
			const [open, setOpen] = React.useState(false)
			const [rect, setRect] = React.useState(null)
			const wrapRef = React.useRef(null)
			const menuRef = React.useRef(null)
			const current = workspaces.find((workspace) => String(workspace.id) === String(value))
			// The menu is portaled to `<body>` (like the shell's own menus) so
			// the panel never clips it; its position follows the trigger.
			const place = () => {
				const node = wrapRef.current
				if (node === null) return
				const box = node.getBoundingClientRect()
				const room = window.innerHeight - box.bottom
				const flip = room < 220 && box.top > room
				setRect({
					left: box.left,
					width: box.width,
					top: flip ? null : box.bottom + 4,
					bottom: flip ? window.innerHeight - box.top + 4 : null,
				})
			}
			// Close on an outside click and on Escape, like the shell's menus.
			React.useEffect(() => {
				if (!open) return undefined
				place()
				const onPointerDown = (event) => {
					const inTrigger = wrapRef.current !== null && wrapRef.current.contains(event.target)
					const inMenu = menuRef.current !== null && menuRef.current.contains(event.target)
					if (!inTrigger && !inMenu) setOpen(false)
				}
				const onKeyDown = (event) => {
					if (event.key !== 'Escape') return
					event.stopPropagation()
					event.preventDefault()
					setOpen(false)
				}
				document.addEventListener('pointerdown', onPointerDown, true)
				document.addEventListener('keydown', onKeyDown, true)
				window.addEventListener('resize', place)
				return () => {
					document.removeEventListener('pointerdown', onPointerDown, true)
					document.removeEventListener('keydown', onKeyDown, true)
					window.removeEventListener('resize', place)
				}
			}, [open])
			const menu = open && rect !== null
				? ReactDOM.createPortal(
					h('div', {
						ref: menuRef,
						className: 'dsh-webseek-menu',
						role: 'listbox',
						'aria-labelledby': labelId,
						style: {
							left: rect.left + 'px',
							width: rect.width + 'px',
							top: rect.top === null ? undefined : rect.top + 'px',
							bottom: rect.bottom === null ? undefined : rect.bottom + 'px',
						},
					},
						workspaces.map((workspace) => h('button', {
							key: String(workspace.id),
							type: 'button',
							role: 'option',
							'aria-selected': String(workspace.id) === String(value),
							className: 'dsh-webseek-menu-item'
								+ (String(workspace.id) === String(value) ? ' selected' : ''),
							onClick: () => { onChange(String(workspace.id)); setOpen(false) },
						},
							h('span', { className: 'dsh-webseek-menu-label' }, workspace.title),
							String(workspace.id) === String(value) ? h(CheckIcon, null) : null,
						)),
					),
					document.body,
				)
				: null
			return h('div', { className: 'dsh-webseek-picker', ref: wrapRef },
				h('button', {
					type: 'button',
					className: 'dsh-webseek-field-btn',
					'aria-haspopup': 'listbox',
					'aria-expanded': open,
					'aria-labelledby': labelId,
					onClick: () => { setOpen((isOpen) => !isOpen); place() },
				},
					h('span', { className: 'dsh-webseek-field-value' }, current === undefined ? '' : current.title),
					h(ChevronIcon, null),
				),
				menu,
			)
		}

		/**
		 * The dialog footer: the project links, the running version, and a live
		 * "check for updates" that asks the host (which asks npm).
		 * @returns React element.
		 */
		function DialogFooter() {
			const [state, setState] = React.useState({ status: 'idle', latest: '' })

			const check = async () => {
				if (state.status === 'checking') return
				setState({ status: 'checking', latest: '' })
				try {
					const response = await fetch('/api/dsh-webseek/update-check')
					const body = await response.json()
					if (body?.ok === true) {
						setState(body.hasUpdate === true
							? { status: 'update', latest: typeof body.latest === 'string' ? body.latest : '' }
							: { status: 'latest', latest: '' })
					} else if (body?.code === 'not-published') {
						setState({ status: 'notPublished', latest: '' })
					} else {
						setState({ status: 'failed', latest: '' })
					}
				} catch (error) {
					setState({ status: 'failed', latest: '' })
				}
			}

			let statusNode = null
			if (state.status === 'latest') {
				statusNode = h('span', { className: 'dsh-webseek-footer-status ok' }, t('footer.latest'))
			} else if (state.status === 'update') {
				statusNode = h('span', { className: 'dsh-webseek-footer-status update' }, t('footer.updateAvailable') + ' v' + state.latest)
			} else if (state.status === 'notPublished') {
				statusNode = h('span', { className: 'dsh-webseek-footer-status' }, t('footer.notPublished'))
			} else if (state.status === 'failed') {
				statusNode = h('span', { className: 'dsh-webseek-footer-status error' }, t('footer.checkFailed'))
			}

			return h('div', { className: 'dsh-webseek-footer' },
				h('div', { className: 'dsh-webseek-footer-links' },
					h('a', {
						className: 'dsh-webseek-footer-link',
						href: REPO_URL, target: '_blank', rel: 'noopener noreferrer',
					}, 'GitHub'),
					h('span', { className: 'dsh-webseek-footer-dot', 'aria-hidden': 'true' }, '·'),
					h('a', {
						className: 'dsh-webseek-footer-link',
						href: ISSUES_URL, target: '_blank', rel: 'noopener noreferrer',
					}, t('footer.feedback')),
				),
				h('div', { className: 'dsh-webseek-footer-meta' },
					h('span', { className: 'dsh-webseek-footer-version' }, 'v' + VERSION),
					h('button', {
						type: 'button',
						className: 'dsh-webseek-linkbtn',
						disabled: state.status === 'checking',
						onClick: () => { void check() },
					}, state.status === 'checking' ? t('footer.checking') : t('footer.check')),
					statusNode,
				),
			)
		}

		/**
		 * The import dialog: the share link, the target workspace, the button.
		 * @param props - `{ onClose, onImported, onOpen }`.
		 * @returns React element.
		 */
		function ImportDialog({ onClose, onImported, onOpen }) {
			const [link, setLink] = React.useState('')
			const [workspaces, setWorkspaces] = React.useState([])
			const [loading, setLoading] = React.useState(true)
			const [workspaceId, setWorkspaceId] = React.useState('')
			const [busy, setBusy] = React.useState(false)
			const [error, setError] = React.useState('')
			const [note, setNote] = React.useState('')
			const [imported, setImported] = React.useState(null)
			const [opening, setOpening] = React.useState(false)
			const inputRef = React.useRef(null)
			const dialogRef = React.useRef(null)

			React.useEffect(() => {
				let alive = true
				fetch('/api/dsh-webseek/workspaces')
					.then((response) => response.json())
					.then((body) => {
						if (!alive) return
						const list = Array.isArray(body?.workspaces) ? body.workspaces : []
						setWorkspaces(list)
						if (list.length > 0) setWorkspaceId((current) => current || String(list[0].id))
					})
					.catch(() => { if (alive) setError(t('error.workspace')) })
					.finally(() => { if (alive) setLoading(false) })
				return () => { alive = false }
			}, [])

			React.useEffect(() => {
				if (inputRef.current !== null) inputRef.current.focus()
			}, [])

			React.useEffect(() => {
				const onKeyDown = (event) => {
					if (event.key === 'Escape') {
						// An open menu owns Escape: it closes itself first.
						if (document.querySelector('.dsh-webseek-menu') !== null) return
						onClose()
						return
					}
					// aria-modal promises the focus stays inside; keep Tab on it.
					if (event.key !== 'Tab' || dialogRef.current === null) return
					const focusable = dialogRef.current.querySelectorAll(
						'button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
					)
					if (focusable.length === 0) return
					const first = focusable[0]
					const last = focusable[focusable.length - 1]
					const active = document.activeElement
					const outside = !dialogRef.current.contains(active)
					if (event.shiftKey && (active === first || outside)) {
						event.preventDefault()
						last.focus()
					} else if (!event.shiftKey && (active === last || outside)) {
						event.preventDefault()
						first.focus()
					}
				}
				document.addEventListener('keydown', onKeyDown, true)
				return () => document.removeEventListener('keydown', onKeyDown, true)
			}, [onClose])

			const submit = async () => {
				if (busy) return
				setBusy(true)
				setError('')
				setNote('')
				try {
					const response = await fetch('/api/dsh-webseek/share-import', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ shareUrl: link, workspaceId }),
					})
					const body = await response.json()
					if (body?.ok !== true) {
						setError(t(errorKey(body?.error)))
						return
					}
					setImported(body)
					if (typeof onImported === 'function') onImported(body)
					const title = typeof body?.title === 'string' && body.title !== '' ? body.title : link.trim()
					const workspaceTitle = typeof body?.workspaceTitle === 'string' && body.workspaceTitle !== '' ? body.workspaceTitle : workspaceId
					setNote((body.already === true ? t('dialog.already') : t('dialog.done')) + '「' + workspaceTitle + '」：' + title)
				} catch (error) {
					setError(t('error.network'))
				} finally {
					setBusy(false)
				}
			}

			const canSubmit = !busy && link.trim() !== '' && workspaceId !== '' && workspaces.length > 0
			return h('div', {
				className: 'dsh-webseek-mask',
				onMouseDown: (event) => { if (event.target === event.currentTarget) onClose() },
			},
				h('div', {
					ref: dialogRef,
					className: 'dsh-webseek-modal',
					role: 'dialog',
					'aria-modal': 'true',
					'aria-label': t('dialog.title'),
				},
					h('div', { className: 'dsh-webseek-modal-title' }, t('dialog.title')),
					h('label', { className: 'dsh-webseek-field' },
						h('span', null, t('dialog.link')),
						h('div', { className: 'dsh-webseek-input' },
							h('input', {
								ref: inputRef,
								value: link,
								placeholder: t('dialog.linkPlaceholder'),
								spellCheck: false,
								autoComplete: 'off',
								onChange: (event) => { setLink(event.target.value); setError('') },
								onKeyDown: (event) => { if (event.key === 'Enter') void submit() },
							}),
						),
					),
					h('div', { className: 'dsh-webseek-field' },
						h('span', { id: WORKSPACE_LABEL_ID }, t('dialog.workspace')),
						workspaces.length === 0
							? h('div', { className: 'dsh-webseek-input' },
								h('input', { value: loading ? t('dialog.workspaceLoading') : t('dialog.workspaceEmpty'), readOnly: true }))
							: h(WorkspacePicker, {
								workspaces,
								value: workspaceId,
								onChange: setWorkspaceId,
								labelId: WORKSPACE_LABEL_ID,
							}),
					),
					error !== '' ? h('div', { className: 'dsh-webseek-error' }, error) : null,
					note !== '' ? h('div', { className: 'dsh-webseek-note' }, note) : null,
					imported !== null
						? h('div', { className: 'dsh-webseek-note' }, t('dialog.treeHint'))
						: null,
					h('div', { className: 'dsh-webseek-actions' },
						imported !== null
							? h('button', {
								type: 'button',
								className: 'dsh-webseek-dialog-btn primary',
								disabled: opening,
								onClick: () => {
									setOpening(true)
									setError('')
									onOpen(imported, () => {
										setOpening(false)
										setError(t('dialog.openTimeout'))
									})
								},
							}, opening ? t('dialog.opening') : t('dialog.open'))
							: null,
						h('button', {
							type: 'button',
							className: 'dsh-webseek-dialog-btn',
							onClick: onClose,
						}, t('dialog.cancel')),
						imported === null
							? h('button', {
								type: 'button',
								className: 'dsh-webseek-dialog-btn primary',
								onClick: () => { void submit() },
								disabled: !canSubmit,
							}, busy ? t('dialog.importing') : t('dialog.submit'))
							: null,
					),
					h(DialogFooter, null),
				),
			)
		}

		/**
		 * Open the imported session the way the user would: through its row.
		 *
		 * The session is durable the moment the host wrote it, but a session
		 * written straight to the log reaches the client's own session lists a
		 * beat later — and `openSession(id)` on a session the client has never
		 * seen lands on the workspace's blank session instead. The sidebar row
		 * is the host's own entry for that session (`data-row-key`), so
		 * clicking it is the one path that always opens the right session.
		 * @param sessionId - the imported session.
		 */
		/** The pending "open the imported session" poll, if any. */
		let openSessionTimer = 0

		/** Stop waiting for the sidebar row. */
		function cancelOpenSession() {
			if (openSessionTimer !== 0) {
				clearTimeout(openSessionTimer)
				openSessionTimer = 0
			}
		}

		/**
		 * Ask the client to re-pull the host's session list.
		 *
		 * The list is a snapshot the host pushes, and it only pushes live
		 * sessions — an imported session lives on disk until the list is pulled
		 * again. The host's list merges cold sessions, so one pull is enough.
		 * @param ctx - client context.
		 */
		function refreshSessionList(ctx) {
			try {
				const sessions = ctx?.get?.('sessions')
				if (sessions !== undefined && typeof sessions.refresh === 'function') {
					void Promise.resolve(sessions.refresh()).catch(() => {})
				}
			} catch (error) { /* the list refreshes on its own */ }
		}

		function openSession(ctx, sessionId, onOpened, onTimeout) {
			if (typeof sessionId !== 'string' || sessionId === '') {
				if (typeof onTimeout === 'function') onTimeout()
				return
			}
			cancelOpenSession()
			const selector = '[data-row-key="session:' + sessionId + '"]'
			// Two ways in, in order of reliability:
			// 1. once the client's session list knows the id, DSH's own open
			//    path works — and unlike clicking a row it does not care whether
			//    the workspace group is expanded;
			// 2. the sidebar row itself, for the window before the list caught up.
			let tries = 120
			let refreshes = 0
			const tick = () => {
				// `refresh()` is single-flight: a pull already in flight returns the
				// list as it was *before* the import, so ask again every few
				// seconds until the new session shows up.
				if (refreshes < 20 && tries % 8 === 0) {
					refreshes += 1
					refreshSessionList(ctx)
				}
				if (clientKnowsSession(ctx, sessionId)) {
					openSessionTimer = 0
					try {
						const ui = ctx?.get?.('uiWorkspace')
						if (ui !== undefined && typeof ui.openSession === 'function') {
							ui.openSession(sessionId)
							if (typeof onOpened === 'function') onOpened()
							return
						}
					} catch (error) { /* fall through to the row */ }
				}
				const row = document.querySelector(selector)
				if (row !== null) {
					openSessionTimer = 0
					row.click()
					if (typeof onOpened === 'function') onOpened()
					return
				}
				if (tries-- <= 0) {
					openSessionTimer = 0
					if (typeof onTimeout === 'function') onTimeout()
					return
				}
				openSessionTimer = setTimeout(tick, 500)
			}
			tick()
		}

		/**
		 * Whether the client's session list already knows this session.
		 * @param sessionId - the session to look for.
		 * @returns true when the list holds it.
		 */
		function clientKnowsSession(ctx, sessionId) {
			try {
				const list = ctx?.get?.('sessions')?.list?.getSnapshot()
				if (list === undefined || list === null) return false
				if (Array.isArray(list.ids)) return list.ids.includes(sessionId)
				return list.byId !== undefined && list.byId !== null && list.byId[sessionId] !== undefined
			} catch (error) {
				return false
			}
		}

		/**
		 * Mount the entry icon and keep it where it belongs.
		 *
		 * The icon goes on the workspace section header row (the row with the
		 * search / view options / add-workspace buttons); if that row cannot be
		 * found — a different DSH build, or the collapsed rail — it falls back
		 * to the plugin row above Settings.
		 * @param ctx - client context.
		 * @returns a disposer that unmounts everything.
		 */
		function mountEntry(ctx) {
			ensureStyle()
			const container = document.createElement('div')
			container.className = 'dsh-webseek-entry'
			const root = createRoot(container)
			root.render(h('button', {
				type: 'button',
				className: 'dsh-webseek-btn',
				title: t('entry.title'),
				'aria-label': t('entry.title'),
				onClick: () => openDialog(ctx),
			}, h(EntryIcon, null)))

			/**
			 * Put the icon into the best host available right now.
			 * @returns {boolean} whether a host was found.
			 */
			const place = () => {
				const region = document.querySelector(WORKSPACE_REGION)
				const header = region === null ? null : region.querySelector(SECTION_HEADER)
				if (header !== null) {
					if (container.parentElement !== header) header.appendChild(container)
					return true
				}
				const footer = document.querySelector(FOOTER_ACTION)
				if (footer !== null) {
					if (container.parentElement !== footer) footer.appendChild(container)
					return true
				}
				return false
			}

			place()
			// The sidebar re-renders (workspace switch, collapse, a session
			// landing); when the host row is rebuilt our node is dropped with it.
			const observer = new MutationObserver(() => {
				if (!container.isConnected) place()
			})
			observer.observe(document.body, { childList: true, subtree: true })

			return () => {
				observer.disconnect()
				closeDialog()
				try { root.unmount() } catch (error) { /* already gone */ }
				try { container.remove() } catch (error) { /* already gone */ }
			}
		}

		/** The open dialog, if any — one at a time, so a second click cannot stack modals. */
		let openDialogHandle = null

		/**
		 * Close the open dialog (if any) and give the focus back.
		 */
		function closeDialog() {
			cancelOpenSession()
			if (openDialogHandle === null) return
			const handle = openDialogHandle
			openDialogHandle = null
			try { handle.root.unmount() } catch (error) { /* already gone */ }
			try { handle.host.remove() } catch (error) { /* already gone */ }
			if (handle.previousFocus !== null && handle.previousFocus.isConnected) {
				try { handle.previousFocus.focus() } catch (error) { /* gone */ }
			}
		}

		/**
		 * Open the import dialog in its own root on `<body>`.
		 * @param ctx - client context.
		 */
		function openDialog(ctx) {
			if (openDialogHandle !== null) return
			ensureStyle()
			const host = document.createElement('div')
			document.body.appendChild(host)
			const root = createRoot(host)
			const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
			openDialogHandle = { root, host, previousFocus }
			root.render(h(ImportDialog, {
				onClose: closeDialog,
				onImported: () => {
					// The client's session list is a snapshot the host pushes; a
					// session that only exists on disk is in it after the next
					// pull, so ask for that pull instead of waiting for a reload.
					refreshSessionList(ctx)
				},
			onOpen: (body, onTimeout) => {
					// The list may not have caught up yet; pull it once more before
					// trying to open.
					refreshSessionList(ctx)
					// The dialog stays open until the session really opens, so the
					// user sees what happened.
					openSession(ctx, body?.sessionId, closeDialog, onTimeout)
				},
			}))
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
		 * with `ctx.get` inside apply.
		 * @param ctx - client context (slots, locale, uiWorkspace).
		 */
		function apply(ctx) {
			console.info('[dsh-webseek] apply')
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
			})

			let dispose = null
			ctx.effect(() => {
				dispose = mountEntry(ctx)
				return () => {
					if (dispose !== null) dispose()
					dispose = null
				}
			}, 'webseek: entry icon')
		}

		const inject = []

		exports.apply = apply
		exports.inject = inject
		return module.exports
	},
})
