/**
 * Standalone harness for the host half: it stands in for the DSH web server
 * (same register/registerUpgrade contract, same prefix matching) and drives the
 * plugin through spawn -> proxy -> WebSocket upgrade, then disposes it.
 *
 *   node test/standalone.mjs [port]
 */
import http from 'node:http'
import net from 'node:net'

const ROOT = '/dsh-vscode-ide'
const PORT = Number(process.argv[2] ?? 0) || 0

const exact = new Map()
const prefixes = new Map()
const upgrades = new Map()
const disposers = []

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://x').pathname
  if (exact.has(pathname)) return void exact.get(pathname)(req, res)
  for (const [prefix, handler] of prefixes) {
    if (pathname.startsWith(prefix)) return void handler(req, res)
  }
  res.writeHead(404)
  res.end('not found')
})

server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url ?? '/', 'http://x').pathname
  const handler = upgrades.get(pathname)
  if (handler === undefined) {
    console.log('[harness] MISS', JSON.stringify(pathname), 'len', pathname.length, 'codepoints', Array.from(pathname.slice(-6)).map((c) => c.codePointAt(0)))
    for (const key of upgrades.keys()) console.log('[harness] KEY ', JSON.stringify(key), 'len', key.length, 'codepoints', Array.from(key.slice(-6)).map((c) => c.codePointAt(0)))
  }
  if (handler === undefined) {
    socket.destroy()
    return
  }
  handler(req, socket, head)
})

const ctx = {
  logger: {
    info: (...args) => { console.log('[info]', ...args) },
    warn: (...args) => { console.warn('[warn]', ...args) },
  },
  webServer: {
    register(route) {
      const table = route.kind === 'exact' ? exact : prefixes
      if (table.has(route.path)) throw new Error(`duplicate ${route.kind} route ${route.path}`)
      table.set(route.path, route.handler)
      return () => { table.delete(route.path) }
    },
    registerUpgrade(route) {
      if (upgrades.has(route.path)) throw new Error(`duplicate upgrade route ${route.path}`)
      upgrades.set(route.path, route.handler)
      return () => { upgrades.delete(route.path) }
    },
  },
  effect(fn) {
    const disposer = fn()
    if (typeof disposer === 'function') disposers.push(disposer)
    return disposer
  },
  inject() {},
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

function get(path) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port: server.address().port, path }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }))
    })
    request.setTimeout(15_000, () => request.destroy(new Error('timeout')))
    request.on('error', reject)
  })
}

/** A raw WebSocket handshake: enough to prove the proxy upgrades upstream. */
function handshake(path, origin) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(server.address().port, '127.0.0.1', () => {
      socket.write([
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${server.address().port}`,
        `Origin: ${origin}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        '',
        '',
      ].join('\r\n'))
    })
    let text = ''
    socket.setTimeout(12_000, () => { socket.destroy(); reject(new Error('handshake timeout')) })
    socket.on('data', (chunk) => {
      text += chunk.toString('latin1')
      if (text.includes('\r\n\r\n')) {
        socket.end()
        resolve(text.split('\r\n')[0])
      }
    })
    socket.on('error', reject)
  })
}

const { apply } = await import('../lib/index.js')

await new Promise((resolve) => { server.listen(PORT, '127.0.0.1', resolve) })
const publicPort = server.address().port
console.log(`harness listening on http://127.0.0.1:${publicPort}`)

apply(ctx, { folder: process.cwd() })

const deadline = Date.now() + 240_000
let status = null
while (Date.now() < deadline) {
  const answer = await get(`${ROOT}/status`).catch(() => null)
  if (answer !== null) {
    status = JSON.parse(answer.body)
    process.stdout.write(`\rstatus=${status.status} port=${status.port} commit=${status.commit ?? '-'}   `)
    if (status.status === 'ready' || status.status === 'error') break
  }
  await sleep(1500)
}
console.log('')

if (status === null || status.status !== 'ready') {
  console.error('FAILED: server never became ready')
  console.error(JSON.stringify(status, null, 2))
  for (const dispose of disposers.reverse()) await dispose()
  await new Promise((resolve) => { server.close(resolve) })
  process.exit(1)
}

const index = await get(`${ROOT}/vscode/`)
const indexOk = index.status === 200 && index.body.includes(`stable-${status.commit}`)
console.log(`index: status=${index.status} bytes=${index.body.length} stable-ref=${indexOk} frame-headers=${index.headers['x-frame-options'] ?? 'none'}`)

const staticAsset = await get(`${ROOT}/vscode/stable-${status.commit}/static/out/vs/code/browser/workbench/workbench.js`)
console.log(`asset: status=${staticAsset.status} type=${staticAsset.headers['content-type'] ?? '-'}`)

const upgradeLine = await handshake(`${ROOT}/vscode/stable-${status.commit}`, `http://127.0.0.1:${publicPort}`).catch((error) => `ERROR ${error.message}`)
console.log(`websocket: ${upgradeLine}`)

for (const dispose of disposers.reverse()) await dispose()
await sleep(500)
const closed = status.port !== 0
console.log(`disposed=${closed}`)
await new Promise((resolve) => { server.close(resolve) })
process.exit(0)
