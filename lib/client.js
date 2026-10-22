/**
 * dsh-vscode-ide — client half (plain JavaScript, no build step).
 *
 * Registers ONE sidebar tab whose body is a full-height <iframe> pointing at the
 * same-origin VS Code Web route served by the host half
 * (`/dsh-vscode-ide/vscode/`). The host proxies `code serve-web` there, so the
 * frame is first-party — VS Code's `X-Frame-Options: SAMEORIGIN` would refuse a
 * directly-embedded loopback origin.
 *
 * The frame follows the CONVERSATION, not the DSH process: the workbench's
 * `?folder=` query re-points one server at any local directory, so the panel
 * opens the cwd of the session the tab belongs to. `scope.cwd` arrives from
 * better-sidebar's tab props; without that service the session store is the
 * fallback, and with neither the host's default folder is used.
 *
 * Two doors, one panel:
 *   better-sidebar (dsh-better-sidebar) — the host's own right column, used
 *     whenever the service is loaded, because that is where the user's other
 *     tool tabs live.
 *   DSH native right sidebar (`sidebarRightTabs` + `slots`) — the fallback for
 *     a host that runs this plugin on its own.
 * Registering both would draw the same panel twice in one column, so a
 * late-arriving better-sidebar takes the native seat down.
 */
window.__ModuleLoader__.load({
  id: 'dsh-vscode-ide',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const E = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const useRef = React.useRef

    const TAB_ID = 'dsh-vscode-ide'
    const NATIVE_KIND = 'vscode'
    const LOCALE_NS = 'dsh-vscode-ide'
    const FRAME_PATH = '/dsh-vscode-ide/vscode/'
    const THEME_PATH = '/dsh-vscode-ide/theme'

    /* ---- conversation folder --------------------------------------------- */
    /**
     * The workbench accepts `?folder=` as a slash-rooted path and resolves it
     * against the server's local file provider. Windows drive paths therefore
     * become `/e:/explore space/...` — the working form verified against a real
     * `code serve-web`; `C:\...` and `file:///C:/...` both open the wrong thing.
     */
    function workbenchPathOf(cwd) {
      if (typeof cwd !== 'string' || cwd === '') return null
      let value = cwd.replace(/\\/g, '/')
      if (/^[A-Za-z]:\//.test(value)) value = '/' + value.charAt(0).toLowerCase() + value.slice(1)
      else if (value.charAt(0) !== '/') value = '/' + value
      return value
    }

    /**
     * cwd for one session out of the client's own session store. Mirrors what
     * the conversation UI reads (`ctx.sessions.list` snapshot -> `byId[id].cwd`);
     * the store refreshes as sessions load, which is why the panel subscribes.
     */
    function sessionCwdOf(ctx, sessionId) {
      try {
        const sessions = ctx === null || ctx === undefined ? undefined : ctx.get('sessions')
        const list = sessions === null || sessions === undefined ? undefined : sessions.list
        if (list === undefined || list === null || typeof list.getSnapshot !== 'function') return null
        const snapshot = list.getSnapshot()
        const byId = snapshot === null || snapshot === undefined ? undefined : snapshot.byId
        if (byId === undefined || byId === null) return null
        if (typeof sessionId === 'string' && sessionId !== '') {
          const one = byId[sessionId]
          return typeof one?.cwd === 'string' && one.cwd !== '' ? one.cwd : null
        }
        const known = Object.values(byId).filter((one) => typeof one?.cwd === 'string' && one.cwd !== '')
        if (known.length === 0) return null
        if (known.length === 1) return known[0].cwd
        const stampOf = (one) => {
          for (const key of ['updatedAt', 'lastActiveAt', 'lastUsedAt', 'activityAt', 'mtime', 'createdAt']) {
            if (typeof one[key] === 'number') return one[key]
          }
          return 0
        }
        known.sort((a, b) => stampOf(b) - stampOf(a))
        return known[0].cwd
      } catch (error) { void error }
      return null
    }

    /**
     * The conversation the user has open. The workspace selection store persists
     * it under `dsh.sessions.current` as `{"sessionId":"session-…"}`, so the panel
     * can follow the *open* conversation instead of the one that opened the tab —
     * switching conversations re-points the workbench, which is the whole point.
     */
    const CURRENT_SESSION_KEY = 'dsh.sessions.current'

    function currentSessionId() {
      try {
        const raw = window.localStorage.getItem(CURRENT_SESSION_KEY)
        if (typeof raw !== 'string' || raw === '') return null
        const parsed = JSON.parse(raw)
        const id = parsed === null || parsed === undefined ? null : parsed.sessionId
        return typeof id === 'string' && id !== '' ? id : null
      } catch (error) { void error }
      return null
    }

    /** Re-renders when the open conversation changes (the key is not ours to observe). */
    function useCurrentSessionId() {
      const [id, setId] = useState(currentSessionId)
      useEffect(() => {
        const read = () => {
          const next = currentSessionId()
          if (next !== null) setId((previous) => (previous === next ? previous : next))
        }
        read()
        const timer = setInterval(read, 400)
        window.addEventListener('focus', read)
        window.addEventListener('storage', read)
        return () => {
          clearInterval(timer)
          window.removeEventListener('focus', read)
          window.removeEventListener('storage', read)
        }
      }, [])
      return id
    }

    /** Live cwd of the tab's session: re-renders when the store learns/changes it. */
    function useLiveCwd(ctx, sessionId) {
      const [cwd, setCwd] = useState(null)
      useEffect(() => {
        const sessions = ctx === null || ctx === undefined ? undefined : ctx.get('sessions')
        const list = sessions === null || sessions === undefined ? undefined : sessions.list
        if (list === undefined || list === null || typeof list.subscribe !== 'function') return undefined
        const read = () => {
          try { setCwd(sessionCwdOf(ctx, sessionId)) } catch (error) { void error }
        }
        read()
        const stop = list.subscribe(read)
        return () => { try { if (typeof stop === 'function') stop() } catch (error) { void error } }
      }, [ctx, sessionId])
      return cwd
    }

    /* ---- light / dark ----------------------------------------------------- */
    /**
     * DSH stamps the resolved scheme on the root element
     * (`<html data-ds-theme-source="dark|light">`) and mirrors it into
     * `color-scheme`. That attribute is the authority; `prefers-color-scheme`
     * follows the operating system, which is not the theme the user picked here.
     * Fallbacks are the page background's luminance and the OS preference.
     */
    function schemeOf() {
      try {
        const stamped = document.documentElement.getAttribute('data-ds-theme-source')
        if (stamped === 'dark' || stamped === 'light') return stamped
        const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(document.body).backgroundColor)
        if (match !== null) {
          const luminance = (0.2126 * Number(match[1]) + 0.7152 * Number(match[2]) + 0.0722 * Number(match[3])) / 255
          return luminance < 0.5 ? 'dark' : 'light'
        }
      } catch (error) { void error }
      try {
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
      } catch (error) { void error }
      return 'dark'
    }

    /**
     * Where the web workbench actually keeps user settings.
     *
     * Not the server's `<dataDir>/data/User/settings.json` — that file is written
     * and then ignored, because a browser workbench rides on its OWN user-data
     * store: IndexedDB `vscode-web-db`, object store `vscode-userdata-store`,
     * key `/User/settings.json`, whose value is the raw file text as a
     * Uint8Array. The frame is same-origin, so this page can write it directly
     * and the theme survives reloads without touching the host.
     */
    const USER_DATA_DB = 'vscode-web-db'
    const USER_DATA_STORE = 'vscode-userdata-store'
    const USER_SETTINGS_KEY = '/User/settings.json'
    const THEME_FALLBACK = { dark: 'Dark 2026', light: 'Light 2026' }

    let themeIdsPromise = null
    /** Theme ids the running workbench actually ships (the host reads its manifest). */
    function themeIdsOf() {
      if (themeIdsPromise === null) {
        themeIdsPromise = fetch(THEME_PATH, { cache: 'no-store' })
          .then((answer) => (answer.ok ? answer.json() : null))
          .then((body) => (body !== null && body.ids !== undefined && body.ids !== null ? body.ids : THEME_FALLBACK))
          .catch(() => THEME_FALLBACK)
      }
      return themeIdsPromise
    }

    function userDataDb() {
      return new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') { reject(new Error('no indexedDB')); return }
        const request = indexedDB.open(USER_DATA_DB)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('indexedDB open failed'))
      })
    }

    function decodeText(value) {
      if (value instanceof Uint8Array) return new TextDecoder().decode(value)
      if (value instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(value))
      if (typeof value === 'string') return value
      return ''
    }

    /**
     * Point the persisted user settings at the theme for `scheme`, and drop the
     * configuration snapshots that would otherwise outrank the file we just
     * wrote. Resolves `true` when something changed, i.e. when the frame has to
     * boot again to show it.
     */
    async function writeWorkbenchTheme(scheme) {
      const ids = await themeIdsOf()
      const wanted = ids !== null && typeof ids[scheme] === 'string' ? ids[scheme] : THEME_FALLBACK[scheme]
      const db = await userDataDb()
      try {
        if (!db.objectStoreNames.contains(USER_DATA_STORE)) return false
        const current = await new Promise((resolve) => {
          const tx = db.transaction(USER_DATA_STORE, 'readonly')
          const request = tx.objectStore(USER_DATA_STORE).get(USER_SETTINGS_KEY)
          request.onsuccess = () => resolve(request.result ?? null)
          request.onerror = () => resolve(null)
        })
        let settings = {}
        try {
          const parsed = JSON.parse(decodeText(current))
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) settings = parsed
        } catch (error) { void error }
        if (settings['workbench.colorTheme'] === wanted && settings['window.autoDetectColorScheme'] === false) return false
        settings['workbench.colorTheme'] = wanted
        settings['window.autoDetectColorScheme'] = false
        const text = `${JSON.stringify(settings, null, 2)}\n`
        const keys = await new Promise((resolve) => {
          const tx = db.transaction(USER_DATA_STORE, 'readonly')
          const request = tx.objectStore(USER_DATA_STORE).getAllKeys()
          request.onsuccess = () => resolve(request.result ?? [])
          request.onerror = () => resolve([])
        })
        const doomed = keys.filter((key) => typeof key === 'string' && key.indexOf('/User/caches/CachedConfigurations') === 0)
        await new Promise((resolve, reject) => {
          const tx = db.transaction(USER_DATA_STORE, 'readwrite')
          const store = tx.objectStore(USER_DATA_STORE)
          for (const key of doomed) store.delete(key)
          store.put(new TextEncoder().encode(text), USER_SETTINGS_KEY)
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error ?? new Error('user settings write failed'))
          tx.onabort = () => reject(tx.error ?? new Error('user settings write aborted'))
        })
        return true
      } finally {
        db.close()
      }
    }

    /**
     * The scheme the frame is visibly showing, sampled from its workbench root.
     *
     * The class token is no help: the `vs`/`vs-dark` classes no longer follow the
     * colour theme in current builds (the 2026 themes render dark while the root
     * still says `vs`), so the painted background is the honest signal.
     */
    function frameSchemeOf(frame) {
      try {
        const workbench = frame?.contentDocument?.querySelector('.monaco-workbench')
        if (!workbench) return null
        const bg = getComputedStyle(workbench).backgroundColor
        const match = /rgba?\(\s*(\d+)[^\d]+(\d+)[^\d]+(\d+)/.exec(String(bg))
        if (match === null) return null
        const luminance = (0.2126 * Number(match[1]) + 0.7152 * Number(match[2]) + 0.0722 * Number(match[3])) / 255
        return luminance < 0.5 ? 'dark' : 'light'
      } catch (error) {
        void error
        return null
      }
    }

    /* ---- locale ---------------------------------------------------------- */
    const ZH = {
      title: '代码',
      description: '在侧边栏里跑完整的 VS Code 网页版，边聊边看代码',
      reload: '重新加载',
      hint: '首次打开会下载并启动 VS Code Server（约 1 分钟）。',
      settings: 'VS Code 面板',
      folder: '当前对话目录',
    }
    const EN = {
      title: 'Code',
      description: 'Full VS Code in the sidebar — chat and read code side by side',
      reload: 'Reload',
      hint: 'The first open downloads and starts the VS Code Server (~1 minute).',
      settings: 'VS Code panel',
      folder: 'Conversation folder',
    }

    function activeTagOf(ctx) {
      try {
        const locale = ctx.get('locale')
        if (locale === undefined || locale === null) return 'zh'
        const value = locale.activeTag ?? locale.tag ?? locale.currentTag
        if (typeof value === 'string' && value !== '') return value
        for (const name of ['getActiveTag', 'getTag', 'active']) {
          if (typeof locale[name] === 'function') {
            const tag = locale[name]()
            if (typeof tag === 'string' && tag !== '') return tag
          }
        }
      } catch (error) { void error }
      return 'zh'
    }

    function translatorOf(ctx) {
      let cachedTag = null
      let cachedDict = EN
      return (key) => {
        const tag = String(activeTagOf(ctx)).toLowerCase()
        if (tag !== cachedTag) {
          cachedTag = tag
          cachedDict = tag.startsWith('zh') ? ZH : EN
        }
        const text = cachedDict[key]
        if (typeof text === 'string') return text
        return typeof ZH[key] === 'string' ? ZH[key] : key
      }
    }

    /* ---- panel ----------------------------------------------------------- */
    const CSS = `
.dsv-root { position: relative; display: flex; flex-direction: column; height: 100%; min-height: 0; width: 100%; background: #1f1f1f; }
.dsv-root[data-scheme="light"] { background: #f8f8f8; }
.dsv-frame { flex: 1 1 auto; display: block; width: 100%; height: 100%; min-height: 0; border: 0; background: #1f1f1f; }
.dsv-root[data-scheme="light"] .dsv-frame { background: #f8f8f8; }
.dsv-tools { position: absolute; top: 6px; right: 10px; display: flex; gap: 6px; opacity: 0; pointer-events: none; transition: opacity .15s ease; z-index: 4; }
.dsv-root:hover .dsv-tools, .dsv-root:focus-within .dsv-tools { opacity: 1; pointer-events: auto; }
.dsv-btn { font: 11px/1 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; padding: 5px 8px; border-radius: 4px;
  border: 1px solid rgba(255,255,255,.14); background: rgba(42,42,42,.94); color: #ddd; cursor: pointer; }
.dsv-btn:hover { background: rgba(64,64,64,.96); color: #fff; }
.dsv-path { position: absolute; bottom: 8px; left: 10px; max-width: 62%; z-index: 4; pointer-events: none;
  font: 11px/1.5 ui-monospace, "Cascadia Code", Consolas, monospace; color: #c8c8c8; background: rgba(0,0,0,.5);
  padding: 3px 8px; border-radius: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  opacity: 0; transition: opacity .15s ease; }
.dsv-root:hover .dsv-path { opacity: 1; }
.dsv-root[data-scheme="light"] .dsv-btn { border-color: rgba(0,0,0,.14); background: rgba(255,255,255,.94); color: #333; }
.dsv-root[data-scheme="light"] .dsv-btn:hover { background: #fff; color: #111; }
.dsv-root[data-scheme="light"] .dsv-path { color: #444; background: rgba(255,255,255,.72); }
`

    function Panel(props) {
      const t = props.t
      const scope = props.scope
      const owner = props.ctx ?? props.pluginCtx
      const scoped = scope?.sessionId ?? props.tab?.scopeSessionId
      const current = useCurrentSessionId()
      // The open conversation wins: the tab was opened from one session, but the
      // user expects the workbench to show whatever conversation is in front.
      const sessionId = current ?? scoped
      const live = useLiveCwd(owner, sessionId)
      const cwd = live ?? (typeof scope?.cwd === 'string' && scope.cwd !== '' ? scope.cwd : null)
      const folder = workbenchPathOf(cwd)

      const [scheme, setScheme] = useState(schemeOf)
      const [nonce, setNonce] = useState(0)
      const [warm, setWarm] = useState(false)
      const hostRef = useRef(null)
      const syncRef = useRef({ attempts: 0, busy: false })

      useEffect(() => {
        const timer = setInterval(() => {
          const next = schemeOf()
          setScheme((value) => (value === next ? value : next))
        }, 700)
        return () => clearInterval(timer)
      }, [])

      // Set the theme for the frame's FIRST boot: a warm profile then opens
      // straight in the right one instead of flashing the default.
      useEffect(() => {
        let live2 = true
        writeWorkbenchTheme(schemeOf())
          .catch((error) => { void error })
          .then(() => { if (live2) setWarm(true) })
        return () => { live2 = false }
      }, [])

      // A frame that booted before that write — or that outlived a scheme flip —
      // is brought in line by rewriting the store and booting it once more.
      useEffect(() => {
        syncRef.current.attempts = 0
        const timer = setInterval(() => {
          const showing = frameSchemeOf(hostRef.current)
          if (showing === null) return
          if (showing === scheme) { syncRef.current.attempts = 0; return }
          if (syncRef.current.busy || syncRef.current.attempts >= 3) return
          syncRef.current.busy = true
          syncRef.current.attempts += 1
          writeWorkbenchTheme(scheme)
            .then((changed) => { if (changed) setNonce((value) => value + 1) })
            .catch((error) => { void error })
            .then(() => { syncRef.current.busy = false })
        }, 2000)
        return () => clearInterval(timer)
      }, [scheme, nonce])

      if (!warm) return E('div', { className: 'dsv-root dsv-boot' })
      const query = []
      if (folder !== null) query.push(`folder=${encodeURIComponent(folder)}`)
      if (nonce > 0) query.push(`r=${String(nonce)}`)
      const src = query.length === 0 ? FRAME_PATH : `${FRAME_PATH}?${query.join('&')}`
      return E('div', { className: 'dsv-root', 'data-scheme': scheme },
        E('iframe', {
          key: src,
          ref: hostRef,
          className: 'dsv-frame',
          src,
          title: folder === null ? t('title') : `${t('title')} — ${folder}`,
          allow: 'clipboard-read; clipboard-write; fullscreen; autoplay',
        }),
        folder === null ? null : E('div', { className: 'dsv-path', title: `${t('folder')}: ${folder}` }, folder),
        E('div', { className: 'dsv-tools' },
          E('button', {
            type: 'button',
            className: 'dsv-btn',
            title: t('reload'),
            'aria-label': t('reload'),
            onClick: () => { setNonce((value) => value + 1) },
          }, t('reload'))))
    }

    /* ---- registration ---------------------------------------------------- */
    function apply(ctx) {
      const style = document.createElement('style')
      style.setAttribute('data-dsh-vscode-ide', '')
      style.textContent = CSS
      document.head.appendChild(style)
      ctx.effect(() => () => { style.remove() }, 'dsh-vscode-ide: panel styles')

      const t = translatorOf(ctx)
      const localeService = ctx.get('locale')
      if (localeService !== undefined && localeService !== null && typeof localeService.register === 'function') {
        ctx.effect(() => localeService.register(LOCALE_NS, { zh: ZH, en: EN }), 'dsh-vscode-ide: locale dictionaries')
      }

      const panelOf = (tabProps) => E(Panel, Object.assign({ pluginCtx: ctx }, tabProps, { t }))

      let nativeFiber = null
      let hostedByBetterSidebar = false

      const hostNatively = () => {
        if (nativeFiber !== null || hostedByBetterSidebar) return
        nativeFiber = ctx.inject(['sidebarRightTabs', 'slots'], (nativeCtx) => {
          const tabs = nativeCtx.get('sidebarRightTabs')
          const slots = nativeCtx.get('slots')
          if (tabs === undefined || typeof tabs.register !== 'function') return
          if (slots === undefined || typeof slots.inject !== 'function') return
          nativeCtx.effect(() => {
            const offType = tabs.register({
              id: TAB_ID,
              kind: NATIVE_KIND,
              title: () => t('title'),
              guide: [{
                id: TAB_ID,
                order: 60,
                title: () => t('title'),
                description: () => t('description'),
              }],
            })
            const offBody = slots.inject('sidebar.right.pane.tab', () => slots.register(
              { name: 'sidebar.right.pane.tab', key: TAB_ID },
              panelOf,
            ))
            return () => {
              try { offBody() } catch (error) { void error }
              try { offType() } catch (error) { void error }
            }
          }, 'dsh-vscode-ide: native right-sidebar seat')
        })
      }

      const takeNativeDown = () => {
        if (nativeFiber === null) return
        const fiber = nativeFiber
        nativeFiber = null
        void Promise.resolve(fiber.dispose()).catch((error) => { void error })
      }

      ctx.inject(['betterSidebar'], (tabCtx) => {
        const betterSidebar = tabCtx.get('betterSidebar')
        if (betterSidebar === undefined || betterSidebar === null || typeof betterSidebar.registerTab !== 'function') return
        hostedByBetterSidebar = true
        takeNativeDown()
        tabCtx.effect(() => {
          const offTab = betterSidebar.registerTab({
            id: TAB_ID,
            title: () => t('title'),
            description: () => t('description'),
            order: 60,
            single: true,
            component: panelOf,
          })
          return () => {
            try { offTab() } catch (error) { void error }
            hostedByBetterSidebar = false
            hostNatively()
          }
        }, 'dsh-vscode-ide: sidebar tab')
      })

      if (!hostedByBetterSidebar) hostNatively()
    }

    exports.apply = apply
    exports.inject = []
    exports.name = 'dsh-vscode-ide'
    return module.exports
  },
})
