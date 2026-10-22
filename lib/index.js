/**
 * dsh-vscode-ide — host half.
 *
 * Runs a real VS Code web server (`code serve-web`, shipped with the desktop VS
 * Code install) on a private loopback port, then publishes it through the DSH
 * web server on a SAME-ORIGIN path (`/dsh-vscode-ide/vscode/`). The same-origin
 * hop is not cosmetic: `code serve-web` answers with
 * `X-Frame-Options: SAMEORIGIN` and `Content-Security-Policy: frame-ancestors
 * 'self'`, so a cross-origin iframe (127.0.0.1:3080 embedding e.g.
 * 127.0.0.1:3197) is refused by the browser. Proxying through the DSH listener
 * makes the frame first-party, and the proxy strips those two headers anyway so
 * the route also works behind a reverse proxy / LAN host.
 *
 * The web client half (lib/client.js) registers the sidebar tab whose body is
 * one <iframe> pointing at this route.
 *
 * Lifecycle: one VS Code server per DSH process, started lazily (or eagerly
 * with `autoStart`) and reused by every session/tab. The WebSocket endpoint
 * lives at `<base>/stable-<commit>`, where <commit> is the build the server
 * currently serves — it changes whenever VS Code auto-updates, so it is
 * discovered from the served index.html after every (re)start.
 */
import { execSync, spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-vscode-ide'
export const inject = ['webServer']

/** Public route root owned by this plugin (prefix route). */
export const ROUTE_ROOT = '/dsh-vscode-ide'
/** Server base path given to `code serve-web`; also the iframe URL. */
export const SERVER_BASE = `${ROUTE_ROOT}/vscode`

const BOOT_TIMEOUT_MS = 20 * 60 * 1000
const MAX_LOG_LINES = 60

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  return path.join(os.homedir(), '.dsh')
}

/** Strip ANSI colour codes so logs stay readable in the panel/status JSON. */
function plain(text) {
  return String(text).replace(/\u001b\[[0-9;]*m/g, '')
}

/**
 * Locate the desktop CLI. `code` on PATH is a shell script/shim on POSIX and
 * `code.cmd` on Windows; the desktop install also ships a stable absolute path,
 * which is used when PATH resolution fails (npm shell env, GUI launch, ...).
 */
function resolveCodeCli(explicit) {
  if (typeof explicit === 'string' && explicit !== '' && existsSync(explicit)) return explicit
  const fromEnv = process.env.DSH_VSCODE_CLI
  if (typeof fromEnv === 'string' && fromEnv !== '' && existsSync(fromEnv)) return fromEnv
  try {
    const out = execSync(process.platform === 'win32' ? 'where code' : 'which code', {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const lines = out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    const preferred = lines.find((line) => /code\.cmd$/i.test(line)) ?? lines[0]
    if (preferred !== undefined) return preferred
  } catch {
    /* PATH lookup is best-effort; the candidates below cover the usual installs. */
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA
    const candidates = [
      local === undefined ? '' : path.join(local, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'),
      'C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd',
      'C:\\Program Files (x86)\\Microsoft VS Code\\bin\\code.cmd',
    ]
    for (const candidate of candidates) {
      if (candidate !== '' && existsSync(candidate)) return candidate
    }
    return 'code.cmd'
  }
  for (const candidate of ['/usr/local/bin/code', '/usr/bin/code', '/snap/bin/code']) {
    if (existsSync(candidate)) return candidate
  }
  return 'code'
}

/**
 * A launch environment with every proxy variable removed. `code serve-web` is a
 * Rust/schannel binary: an HTTP(S)_PROXY pointing at a local proxy whose CONNECT
 * tunnel is broken makes its own VS Code Server download fail with
 * `certificate verify failed` / `CRYPT_E_REVOCATION_OFFLINE`, and it honours
 * NO_PROXY for the loopback listener only — the update endpoints go direct.
 */
function directEnv() {
  const env = { ...process.env }
  for (const key of [
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy',
    'NPM_CONFIG_PROXY', 'NPM_CONFIG_HTTPS_PROXY',
  ]) delete env[key]
  env.NO_PROXY = '*'
  env.no_proxy = '*'
  return env
}

function quoteArg(value) {
  const text = String(value)
  if (process.platform === 'win32') return `"${text.replace(/"/g, '""')}"`
  return `'${text.replace(/'/g, `'\\''`)}'`
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = address === null || typeof address === 'string' ? 0 : address.port
      probe.close(() => { resolve(port) })
    })
  })
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        if (body.length < 400_000) body += chunk
      })
      response.on('end', () => { resolve({ status: response.statusCode, headers: response.headers, body }) })
    })
    request.setTimeout(10_000, () => { request.destroy(new Error('request timeout')) })
    request.on('error', reject)
  })
}

/** The waiting page shown inside the iframe until the server answers. */
function waitingPage(state, detail) {
  const status = state.status === 'error' ? 'error' : 'starting'
  const title = status === 'error' ? 'VS Code 服务启动失败' : '正在启动 VS Code Web…'
  const hint = status === 'error'
    ? '请查看下方原因，或在插件设置中检查 code CLI 路径。'
    : '首次启动会下载并解压 VS Code Server（约 200 MB），通常 1–2 分钟；之后是秒开。'
  const errorRow = state.error === null || state.error === ''
    ? ''
    : `<pre class="err">${escapeHtml(state.error)}</pre>`
  const log = state.log.length === 0 ? '' : `<pre class="log">${escapeHtml(state.log.join('\n'))}</pre>`
  const extra = detail === undefined || detail === '' ? '' : `<p class="detail">${escapeHtml(detail)}</p>`
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="refresh" content="${status === 'error' ? '8' : '3'}">
<title>${title}</title>
<style>
  :root { color-scheme: dark; }
  html, body { height: 100%; margin: 0; }
  body { display: flex; align-items: center; justify-content: center; font: 13px/1.7 ui-sans-serif, system-ui, "Segoe UI", sans-serif;
         background: #1f1f1f; color: #ccc; padding: 24px; box-sizing: border-box; }
  main { max-width: 560px; width: 100%; }
  h1 { font-size: 14px; font-weight: 600; margin: 0 0 8px; color: ${status === 'error' ? '#f48771' : '#e6e6e6'}; display: flex; gap: 8px; align-items: center; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: ${status === 'error' ? '#f48771' : '#3794ff'};
         animation: ${status === 'error' ? 'none' : 'pulse 1.2s ease-in-out infinite'}; }
  @keyframes pulse { 0%, 100% { opacity: .25 } 50% { opacity: 1 } }
  p { margin: 4px 0; color: #9d9d9d; }
  .err, .log { font: 11px/1.6 ui-monospace, Consolas, monospace; background: #141414; border: 1px solid #2b2b2b;
        border-radius: 4px; padding: 8px 10px; margin: 10px 0 0; max-height: 220px; overflow: auto; white-space: pre-wrap;
        color: ${status === 'error' ? '#f48771' : '#8a8a8a'}; }
  .detail { color: #d7ba7d; }
</style></head>
<body><main>
  <h1><span class="dot"></span>${title}</h1>
  <p>${hint}</p>
  ${extra}${errorRow}${log}
</main></body></html>`
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => (
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;'
  ))
}

/**
 * Register the VS Code web server for one DSH process.
 * @param ctx - plugin context; `webServer` is required.
 * @param config - { folder?, codeCli?, autoStart?, serverDataDir?, windowless? }
 */
export function apply(ctx, config = {}) {
  const settings = config ?? {}
  const configuredFolder = typeof settings.folder === 'string' ? settings.folder : ''
  const folder = configuredFolder !== '' && existsSync(configuredFolder) ? configuredFolder : process.cwd()
  const dataDir = typeof settings.serverDataDir === 'string' && settings.serverDataDir !== ''
    ? settings.serverDataDir
    : path.join(dshHome(), 'vscode-web', 'data')

  const state = { status: 'idle', port: 0, commit: null, folder, error: null, log: [], startedAt: 0 }
  let child = null
  let booting = null
  let themeIdsCache = null
  let wsRoute = null

  const pushLog = (chunk) => {
    const text = plain(chunk)
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trimEnd()
      if (trimmed !== '') state.log.push(trimmed)
    }
    if (state.log.length > MAX_LOG_LINES) state.log.splice(0, state.log.length - MAX_LOG_LINES)
  }
  const tailLog = () => (state.log.length === 0 ? '(no output)' : state.log.slice(-12).join('\n'))

  const stopChild = () => {
    const running = child
    child = null
    if (running === null || running.exitCode !== null) return
    try {
      if (process.platform === 'win32' && typeof running.pid === 'number') {
        spawn('taskkill', ['/pid', String(running.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      } else {
        running.kill('SIGTERM')
      }
    } catch {
      /* the process is already gone */
    }
  }

  const onUpgrade = (req, socket, head) => {
    if (state.status !== 'ready' || state.port === 0) {
      socket.destroy()
      return
    }
    const upstream = net.connect(state.port, '127.0.0.1')
    const fail = () => {
      try { socket.destroy() } catch { /* already closed */ }
      upstream.destroy()
    }
    upstream.once('error', fail)
    socket.once('error', fail)
    upstream.once('connect', () => {
      const headers = []
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue
        const flat = Array.isArray(value) ? value.join(', ') : value
        /* The server validates these against its own authority, and the browser
           sent the public DSH origin instead: present the loopback identity it
           actually listens on. */
        if (key === 'host') headers.push(`host: 127.0.0.1:${state.port}`)
        else if (key === 'origin') headers.push(`origin: http://127.0.0.1:${state.port}`)
        else headers.push(`${key}: ${flat}`)
      }
      upstream.write(`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n`)
      if (head !== undefined && head.length > 0) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
  }

  const proxyHttp = (req, res) => {
    const headers = { ...req.headers, host: `127.0.0.1:${state.port}` }
    const upstream = http.request({
      host: '127.0.0.1',
      port: state.port,
      method: req.method,
      path: req.url,
      headers,
    }, (answer) => {
      const replyHeaders = { ...answer.headers }
      /* First-party frame: the browser honours frame-ancestors only for the
         document it is loading, and the DSH origin is not the VS Code origin. */
      delete replyHeaders['x-frame-options']
      for (const key of ['content-security-policy', 'content-security-policy-report-only']) {
        if (typeof replyHeaders[key] === 'string') {
          replyHeaders[key] = replyHeaders[key].replace(/frame-ancestors[^;]*;?/gi, '').trim()
          if (replyHeaders[key] === '') delete replyHeaders[key]
        }
      }
      res.writeHead(answer.statusCode ?? 502, replyHeaders)
      answer.pipe(res)
    })
    upstream.once('error', (error) => {
      pushLog(`proxy error: ${error instanceof Error ? error.message : String(error)}`)
      if (!res.headersSent) {
        state.status = 'idle'
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(waitingPage(state, 'VS Code 服务已停止，正在重启…'))
      } else {
        res.destroy()
      }
    })
    req.once('aborted', () => { upstream.destroy() })
    req.pipe(upstream)
  }

  const waitForReady = async (port, spawned) => {
    const deadline = Date.now() + BOOT_TIMEOUT_MS
    let last = 'no response yet'
    while (Date.now() < deadline) {
      if (spawned.exitCode !== null && spawned.exitCode !== undefined) {
        throw new Error(`serve-web exited early (code ${spawned.exitCode})\n${tailLog()}`)
      }
      try {
        const answer = await httpGet(`http://127.0.0.1:${port}${SERVER_BASE}/`)
        if (answer.status === 200) {
          const match = /\/stable-([0-9a-f]{40})\//.exec(answer.body)
          if (match !== null) return match[1]
          last = 'index.html served without a stable-<commit> reference'
        } else {
          last = `HTTP ${answer.status} (VS Code is still downloading its server build)`
        }
      } catch (error) {
        last = error instanceof Error ? error.message : String(error)
      }
      await sleep(1200)
    }
    throw new Error(`timed out after 20 min waiting for the VS Code web server: ${last}\n${tailLog()}`)
  }

  const startServer = async () => {
    state.status = 'starting'
    state.error = null
    state.startedAt = Date.now()
    state.log = []
    const cli = resolveCodeCli(settings.codeCli)
    state.cli = cli
    const port = await freePort()
    state.port = port
    mkdirSync(dataDir, { recursive: true })
    const args = [
      'serve-web',
      '--host', '127.0.0.1',
      '--port', String(port),
      '--without-connection-token',
      '--accept-server-license-terms',
      '--disable-telemetry',
      '--server-base-path', SERVER_BASE,
      '--server-data-dir', dataDir,
    ]
    if (existsSync(folder)) args.push('--default-folder', folder)
    pushLog(`$ ${cli} ${args.join(' ')}`)
    const command = [quoteArg(cli), ...args.map(quoteArg)].join(' ')
    const spawned = spawn(command, {
      shell: true,
      env: directEnv(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child = spawned
    spawned.stdout?.setEncoding('utf8')
    spawned.stderr?.setEncoding('utf8')
    spawned.stdout?.on('data', pushLog)
    spawned.stderr?.on('data', pushLog)
    spawned.once('error', (error) => { pushLog(`spawn error: ${error.message}`) })
    spawned.once('exit', (code) => {
      if (child !== spawned) return
      child = null
      if (state.status === 'ready') {
        state.status = 'idle'
        pushLog(`serve-web stopped (code ${code})`)
      } else if (state.status !== 'error') {
        state.status = 'error'
        state.error = `serve-web exited early (code ${code})`
      }
    })
    const commit = await waitForReady(port, spawned)
    state.commit = commit
    themeIdsCache = null
    state.status = 'ready'
    if (wsRoute !== null) {
      try { wsRoute() } catch { /* already disposed */ }
      wsRoute = null
    }
    wsRoute = ctx.webServer.registerUpgrade({ path: `${SERVER_BASE}/stable-${commit}`, handler: onUpgrade })
    ctx.logger?.info?.(`[dsh-vscode-ide] ready on 127.0.0.1:${port} (commit ${commit})`)
    return state
  }

  const ensureServer = () => {
    if (state.status === 'ready') return Promise.resolve(state)
    if (booting !== null) return booting
    let pending
    pending = startServer()
      .catch((error) => {
        state.status = 'error'
        state.error = error instanceof Error ? error.message : String(error)
        throw error
      })
      .finally(() => {
        if (booting === pending) booting = null
      })
    booting = pending
    return pending
  }

  /* ---- light / dark ------------------------------------------------------ */
  /**
   * The workbench decides light-or-dark from the USER settings file inside the
   * server data dir, and it reads that file only when a workbench boots — a live
   * workbench ignores an edit to it (verified). `workbench.colorTheme` is pinned
   * to the two built-in themes, and the client asks for the matching one before
   * it (re)loads the frame.
   */
  /* The bundled theme ids change between releases: newer builds ship
     "Dark 2026"/"Light 2026" and no longer know "Default Dark Modern", and an
     unknown id falls back to the LIGHT default (which is why a stale id looked
     like "the theme never follows"). Read the ids from the installed
     theme-defaults extension instead of hard-coding one release's names. */
  const themeIds = () => {
    if (themeIdsCache !== null) return themeIdsCache
    const candidates = []
    if (typeof state.commit === 'string' && state.commit !== '') {
      candidates.push(path.join(os.homedir(), '.vscode', 'cli', 'serve-web', state.commit, 'extensions', 'theme-defaults', 'package.json'))
    }
    if (typeof state.cli === 'string' && state.cli !== '') {
      candidates.push(path.join(path.dirname(path.dirname(state.cli)), 'resources', 'app', 'extensions', 'theme-defaults', 'package.json'))
    }
    for (const file of candidates) {
      let parsed
      try {
        parsed = JSON.parse(readFileSync(file, 'utf8'))
      } catch (error) {
        void error
        continue
      }
      const themes = parsed?.contributes?.themes
      if (!Array.isArray(themes)) continue
      const pick = (uiTheme, preferred) => {
        const hits = themes.filter((theme) => theme?.uiTheme === uiTheme && typeof theme?.id === 'string')
        if (hits.length === 0) return null
        const exact = hits.find((theme) => theme.id === preferred)
        if (exact !== undefined) return exact.id
        const modern = hits.find((theme) => /modern|2026/i.test(theme.id))
        return (modern ?? hits[0]).id
      }
      const dark = pick('vs-dark', 'Dark 2026')
      const light = pick('vs', 'Light 2026')
      if (dark !== null && light !== null) {
        themeIdsCache = { dark, light, source: file }
        return themeIdsCache
      }
    }
    themeIdsCache = { dark: 'Dark 2026', light: 'Light 2026', source: '(fallback)' }
    return themeIdsCache
  }

  const userSettingsFile = () => path.join(dataDir, 'data', 'User', 'settings.json')

  const themeOfSettings = () => {
    try {
      const parsed = JSON.parse(readFileSync(userSettingsFile(), 'utf8'))
      const theme = typeof parsed?.['workbench.colorTheme'] === 'string' ? parsed['workbench.colorTheme'] : ''
      if (theme === themeIds().light) return 'light'
      if (theme === themeIds().dark) return 'dark'
      return /light/i.test(theme) ? 'light' : 'dark'
    } catch {
      return 'dark'
    }
  }

  /**
   * Mirror the scheme into the server's user settings file.
   *
   * The browser workbench does NOT read this file: a web workbench keeps user
   * settings in its own user-data store (browser IndexedDB), which the client
   * half writes directly. The mirror stays because it is cheap and keeps the
   * file on disk honest for anyone who opens it.
   */
  const mirrorThemeOnDisk = (mode) => {
    const ids = themeIds()
    const wanted = ids[mode]
    const file = userSettingsFile()
    mkdirSync(path.dirname(file), { recursive: true })
    let current = {}
    try {
      const raw = readFileSync(file, 'utf8')
      try {
        const parsed = JSON.parse(raw)
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed
      } catch {
        /* JSONC or corrupted: keep a copy rather than silently dropping the user's file */
        try { copyFileSync(file, `${file}.dsh-bak`) } catch { /* best effort */ }
      }
    } catch {
      /* no settings file yet */
    }
    current['workbench.colorTheme'] = wanted
    current['window.autoDetectColorScheme'] = false
    current['workbench.preferredDarkColorTheme'] = ids.dark
    current['workbench.preferredLightColorTheme'] = ids.light
    writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`, 'utf8')
    pushLog(`theme -> ${mode} (${wanted})`)
    return { mode, theme: wanted, file, source: ids.source }
  }

  const onTheme = (req, res) => {
    const parsed = new URL(req.url ?? '/', 'http://127.0.0.1')
    const mode = String(parsed.searchParams.get('mode') ?? '').toLowerCase()
    const reply = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    if (mode === '') {
      reply(200, { mode: themeOfSettings(), file: userSettingsFile(), ids: themeIds() })
      return
    }
    if (mode !== 'dark' && mode !== 'light') {
      reply(400, { error: `mode must be "dark" or "light", got "${mode}"` })
      return
    }
    try {
      reply(200, { ok: true, ...mirrorThemeOnDisk(mode) })
    } catch (error) {
      reply(500, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  const onRequest = (req, res) => {
    const url = req.url ?? '/'
    if (url === `${ROUTE_ROOT}/theme` || url.startsWith(`${ROUTE_ROOT}/theme?`)) {
      onTheme(req, res)
      return
    }
    if (url === `${ROUTE_ROOT}/status` || url.startsWith(`${ROUTE_ROOT}/status?`)) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({
        status: state.status,
        port: state.port,
        commit: state.commit,
        folder,
        error: state.error,
        uptimeMs: state.startedAt === 0 ? 0 : Date.now() - state.startedAt,
        log: state.log.slice(-12),
      }, null, 2))
      return
    }
    if (state.status !== 'ready') {
      void ensureServer().catch(() => { /* the waiting page carries the reason */ })
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(waitingPage(state))
      return
    }
    proxyHttp(req, res)
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE_ROOT, handler: onRequest }),
    'dsh-vscode-ide: /dsh-vscode-ide proxy route',
  )

  ctx.effect(() => () => {
    if (wsRoute !== null) {
      try { wsRoute() } catch { /* already disposed */ }
      wsRoute = null
    }
    stopChild()
    state.status = 'idle'
  }, 'dsh-vscode-ide: VS Code server lifecycle')

  if (settings.autoStart !== false) {
    void ensureServer().catch((error) => {
      ctx.logger?.warn?.(error instanceof Error ? error : new Error(String(error)))
    })
  }
}
