/**
 * dsh-webseek — local direct corridor.
 *
 * The user's machine routes ALL traffic through a proxy whose egress IP is
 * blocked by chat.deepseek.com's CloudFront (403 "Request blocked"), and the
 * desktop webview offers no way to set a per-session proxy (element.session
 * is undefined in the shell renderer; the host half runs in a different
 * Electron process than the GUI that owns the webviews). Direct connections
 * from this machine work fine.
 *
 * So the guest loads a local reverse proxy instead of the real origin:
 * `http://127.0.0.1:<ephemeral>/` → https://chat.deepseek.com, plus
 * `http://127.0.0.1:<ephemeral>/__fe-static/...` → the webpack publicPath
 * host fe-static.deepseek.com (its `<script crossorigin>` tags fail CORS
 * from a local origin, so its assets must be same-origin too).
 *
 * DeepSeek's SPA calls its API with location-origin-relative paths and ships
 * exactly one hard-coded origin that must be rewritten (the webpack
 * publicPath, verified in main.d1d163b7e4.js), so the corridor stays small:
 * no HTML templating, no cookie jar, no header policy beyond what is listed
 * below.
 */
import { connect as tlsConnect } from 'node:tls'
import http from 'node:http'
import { request as httpsRequest } from 'node:https'
import zlib from 'node:zlib'

/** Real origins the corridor reaches. */
export const CHAT_ORIGIN = 'https://chat.deepseek.com'
export const STATIC_ORIGIN = 'https://fe-static.deepseek.com'

/** Local path prefix that routes to the static asset origin. */
export const STATIC_PREFIX = '/__fe-static'

/**
 * Fixed corridor port. The login state is origin-scoped: cookies ignore the
 * port, but localStorage (`userToken`) does not — an ephemeral port would
 * sign the user out on every host restart, so the corridor always binds
 * 37890 and falls back to an ephemeral port only if something else owns it.
 */
export const CORRIDOR_PORT = 37890

/** Identity path answered by a running corridor (reuse probe). */
export const IDENT_PATH = '/dsh-webseek-corridor-ident'
export const IDENT_BODY = 'dsh-webseek-corridor'

/** Origin string replaced inside JS/HTML/CSS bodies (the webpack publicPath). */
export const REWRITE_FROM = 'https://fe-static.deepseek.com'

/** Response headers never forwarded to the guest. */
const STRIP_RESPONSE = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
  'strict-transport-security',
])

/** Request headers never forwarded upstream. */
const STRIP_REQUEST = new Set(['host', 'connection', 'accept-encoding', 'origin', 'referer'])

/**
 * Map a local request path to its upstream.
 * @param {string} pathname - local URL pathname.
 * @returns {{host: string, path: string}}
 */
export function upstreamFor(pathname) {
  if (pathname === STATIC_PREFIX || pathname.startsWith(STATIC_PREFIX + '/')) {
    return { host: 'fe-static.deepseek.com', path: pathname.slice(STATIC_PREFIX.length) || '/' }
  }
  return { host: 'chat.deepseek.com', path: pathname }
}

/**
 * Rewrite the one load-bearing absolute origin inside text bodies.
 * @param {string} text
 * @returns {string}
 */
export function rewriteBodyText(text) {
  return text.split(REWRITE_FROM).join(STATIC_PREFIX)
}

/** SRI attributes are computed over the ORIGINAL asset bytes; once the
 * corridor rewrites a body the digest no longer matches and the browser
 * blocks the script — so HTML must drop them. */
const INTEGRITY_ATTRIBUTE = /\s+integrity="(?:sha256|sha384|sha512)-[^"]*"/gi

/**
 * Rewrite an HTML body: origin substitution plus SRI stripping.
 * @param {string} text
 * @returns {string}
 */
export function rewriteHtml(text) {
  return rewriteBodyText(text).replace(INTEGRITY_ATTRIBUTE, '')
}

/**
 * Rewrite a Location/refresh header so redirects stay inside the corridor.
 * @param {string} value - header value (absolute URL or relative path).
 * @returns {string} a relative path when the value pointed at a proxied origin.
 */
export function rewriteLocation(value) {
  if (typeof value !== 'string') return value
  try {
    const url = new URL(value, CHAT_ORIGIN)
    if (url.origin === 'https://chat.deepseek.com') {
      return url.pathname + url.search + url.hash
    }
    if (url.origin === STATIC_ORIGIN) {
      return STATIC_PREFIX + url.pathname + url.search + url.hash
    }
    return value
  } catch (error) {
    return value
  }
}

/**
 * Drop cookie attributes that a plain-HTTP local origin cannot receive
 * (Secure) or should not scope to the real origin (Domain).
 * @param {string} cookie - one Set-Cookie value.
 * @returns {string}
 */
export function stripCookieFlags(cookie) {
  return cookie
    .split(';')
    .filter((part) => {
      const name = part.trim().split('=')[0].toLowerCase()
      return name !== 'domain' && name !== 'secure' && name !== 'samesite'
    })
    .join(';')
}

/**
 * Whether a response content-type should be fetched plain and rewritten.
 * Server-sent events stream forever — never buffered.
 * @param {string|undefined} contentType
 * @returns {boolean}
 */
export function isRewritableContentType(contentType) {
  if (typeof contentType !== 'string') return false
  const lower = contentType.toLowerCase()
  if (lower.includes('event-stream')) return false
  return lower.startsWith('text/')
    || lower.includes('javascript')
    || lower.includes('ecmascript')
    || lower.includes('json')
    || lower.includes('xhtml')
}

/** Hard cap for buffered/rewritten bodies (defensive; assets are ~1.6 MB). */
const MAX_REWRITE_BYTES = 33554432

/**
 * Inflate a response body according to its content-encoding, tolerating
 * upstreams that ignored our accept-encoding: identity.
 * @returns {Buffer}
 */
function decodeBody(buffer, encoding) {
  const lower = typeof encoding === 'string' ? encoding.toLowerCase() : ''
  if (lower === 'gzip' || lower === 'x-gzip') return zlib.gunzipSync(buffer)
  if (lower === 'deflate') return zlib.inflateSync(buffer)
  if (lower === 'br') return zlib.brotliDecompressSync(buffer)
  return buffer
}

/**
 * Start the corridor.
 * @param {{log?: (message: string) => void}} [options]
 * @returns {Promise<{url: string, port: number, close: () => Promise<void>}>}
 */
export function createCorridor(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {}
  const server = http.createServer()
  const sockets = new Set()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  server.on('request', (req, res) => {
    let pathname
    try {
      pathname = new URL(req.url, 'http://127.0.0.1').pathname
    } catch (error) {
      res.writeHead(400).end()
      return
    }
    if (pathname === IDENT_PATH) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(IDENT_BODY)
      return
    }
    const target = upstreamFor(pathname)
    const headers = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (STRIP_REQUEST.has(name)) continue
      headers[name] = value
    }
    headers.host = target.host
    headers.origin = CHAT_ORIGIN
    headers.referer = CHAT_ORIGIN + '/'
    headers['accept-encoding'] = 'identity'
    const upstream = httpsRequest({
      host: target.host,
      port: 443,
      path: target.path + (new URL(req.url, 'http://127.0.0.1').search ?? ''),
      method: req.method,
      headers,
      servername: target.host,
    }, (upstreamRes) => {
      const responseHeaders = {}
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (name === 'set-cookie') {
          responseHeaders[name] = (Array.isArray(value) ? value : [value]).map(stripCookieFlags)
          continue
        }
        if (STRIP_RESPONSE.has(name)) continue
        if (name === 'location') {
          responseHeaders[name] = rewriteLocation(value)
          continue
        }
        responseHeaders[name] = value
      }
      const contentType = upstreamRes.headers['content-type']
      if (!isRewritableContentType(contentType)) {
        res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders)
        upstreamRes.pipe(res)
        return
      }
      const chunks = []
      let size = 0
      let overflow = false
      upstreamRes.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_REWRITE_BYTES) {
          overflow = true
          chunks.length = 0
          res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders)
          upstreamRes.pipe(res)
          upstreamRes.removeAllListeners('data')
          return
        }
        chunks.push(chunk)
      })
      upstreamRes.on('error', () => res.destroy())
      upstreamRes.on('end', () => {
        if (overflow) return
        try {
          const plain = decodeBody(Buffer.concat(chunks), upstreamRes.headers['content-encoding']).toString('utf8')
          const isHtml = typeof contentType === 'string' && contentType.toLowerCase().includes('text/html')
          const body = isHtml ? rewriteHtml(plain) : rewriteBodyText(plain)
          delete responseHeaders['content-encoding']
          responseHeaders['content-length'] = Buffer.byteLength(body)
          res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders)
          res.end(body)
        } catch (error) {
          log(`corridor: rewrite failed for ${pathname}: ${String(error)}`)
          res.writeHead(502).end('dsh-webseek corridor: rewrite failed')
        }
      })
    })
    upstream.on('error', (error) => {
      log(`corridor: upstream ${target.host}${target.path} failed: ${String(error)}`)
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('dsh-webseek corridor: upstream failed')
    })
    req.pipe(upstream)
    req.on('error', () => upstream.destroy())
  })

  // WebSocket (if the SPA ever upgrades): tunnel raw bytes over TLS.
  server.on('upgrade', (req, socket, head) => {
    let pathname = '/'
    try {
      pathname = new URL(req.url, 'http://127.0.0.1').pathname
    } catch (error) {
      socket.destroy()
      return
    }
    const target = upstreamFor(pathname)
    const headers = []
    for (const [name, value] of Object.entries(req.headers)) {
      if (name === 'host' || name === 'connection') continue
      headers.push(`${name}: ${name === 'origin' || name === 'referer' ? CHAT_ORIGIN : value}`)
    }
    const upstream = tlsConnect({ host: target.host, port: 443, servername: target.host }, () => {
      upstream.write(
        `${req.method ?? 'GET'} ${target.path} HTTP/1.1\r\nHost: ${target.host}\r\n`
        + headers.join('\r\n') + '\r\nConnection: Upgrade\r\n\r\n',
      )
      if (head.length > 0) upstream.write(head)
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })

  /**
   * Listen on a port; resolve `{server, port, owned}`.
   * EADDRINUSE on the fixed port probes for a sibling corridor and borrows
   * it (the corridor is stateless, so one listener serves every instance);
   * anything else falls back to an ephemeral port (login localStorage then
   * does not survive restarts, but the page still loads).
   */
  function listenOn(port) {
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        server.removeListener('error', onError)
        reject(error)
      }
      server.on('error', onError)
      server.listen({ host: '127.0.0.1', port }, () => {
        server.removeListener('error', onError)
        resolve({ port: server.address().port, owned: true })
      })
    })
  }

  function probeSibling(port) {
    return new Promise((resolve) => {
      const request = http.get({ host: '127.0.0.1', port, path: IDENT_PATH, timeout: 1000 }, (response) => {
        let body = ''
        response.on('data', (chunk) => { body += chunk })
        response.on('end', () => resolve(body.trim() === IDENT_BODY))
      })
      request.on('timeout', () => { request.destroy(); resolve(false) })
      request.on('error', () => resolve(false))
    })
  }

  return (async () => {
    let port = CORRIDOR_PORT
    let owned = true
    try {
      const bound = await listenOn(CORRIDOR_PORT)
      port = bound.port
    } catch (error) {
      const busy = error instanceof Error && 'code' in error && error.code === 'EADDRINUSE'
      if (busy && await probeSibling(CORRIDOR_PORT)) {
        owned = false
      } else {
        const bound = await listenOn(0)
        port = bound.port
      }
    }
    log(`corridor: ${owned ? 'serving' : 'borrowing'} http://127.0.0.1:${port}`)
    return {
      port,
      owned,
      url: `http://127.0.0.1:${port}`,
      close: () => new Promise((done) => {
        if (!owned) return done()
        server.close(() => done())
        for (const socket of sockets) socket.destroy()
      }),
    }
  })()
}
