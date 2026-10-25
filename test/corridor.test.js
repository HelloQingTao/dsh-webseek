import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  upstreamFor, rewriteBodyText, rewriteHtml, rewriteLocation, stripCookieFlags,
  isRewritableContentType, STATIC_PREFIX, CORRIDOR_PORT, IDENT_PATH,
} from '../lib/corridor.js'
import { corridorEnabled, setStateDir, stateDir } from '../lib/index.js'

test('upstreamFor: /__fe-static/* reaches the asset origin stripped, everything else the chat origin', () => {
  assert.deepEqual(upstreamFor('/__fe-static/chat/static/main.js'), { host: 'fe-static.deepseek.com', path: '/chat/static/main.js' })
  assert.deepEqual(upstreamFor(STATIC_PREFIX), { host: 'fe-static.deepseek.com', path: '/' })
  assert.deepEqual(upstreamFor('/api/v0/chat_session/fetch_page'), { host: 'chat.deepseek.com', path: '/api/v0/chat_session/fetch_page' })
  assert.deepEqual(upstreamFor('/'), { host: 'chat.deepseek.com', path: '/' })
})

test('rewriteBodyText: rewrites the webpack publicPath, leaves other origins alone', () => {
  const rewritten = rewriteBodyText('h.p="https://fe-static.deepseek.com/chat/"')
  assert.equal(rewritten, 'h.p="' + STATIC_PREFIX + '/chat/"')
  const untouched = rewriteBodyText('appleRedirectURI:"https://chat.deepseek.com/oauth_apple_callback"')
  assert.equal(untouched, 'appleRedirectURI:"https://chat.deepseek.com/oauth_apple_callback"')
  // Idempotent: a twice-rewritten body stays valid (no /__fe-static/__fe-static).
  assert.equal(rewriteBodyText(rewritten), rewritten)
})

test('rewriteHtml: origin substitution plus SRI attribute stripping', () => {
  const html = '<script crossorigin src="https://fe-static.deepseek.com/chat/static/main.js"'
    + ' integrity="sha384-PretKgCiMfp5udSeLwRk6g3V7JU5JAbSTVWT/Cn5X9vvx5FIepJF8wZvvMYwC3Qc"></script>'
  const out = rewriteHtml(html)
  assert.equal(out.includes('integrity='), false, 'SRI must be dropped: the rewritten body breaks the digest')
  assert.equal(out.includes(STATIC_PREFIX + '/chat/static/main.js'), true)
})

test('rewriteLocation: keeps redirects inside the corridor', () => {
  assert.equal(rewriteLocation('https://chat.deepseek.com/a/b?x=1#h'), '/a/b?x=1#h')
  assert.equal(rewriteLocation('https://fe-static.deepseek.com/chat/c.css'), STATIC_PREFIX + '/chat/c.css')
  assert.equal(rewriteLocation('/already/relative'), '/already/relative')
  assert.equal(rewriteLocation('https://other.example.com/x'), 'https://other.example.com/x')
})

test('stripCookieFlags: drops Domain/Secure/SameSite, keeps the rest verbatim', () => {
  const kept = stripCookieFlags('sessionid=abc; Domain=chat.deepseek.com; Path=/; Secure; HttpOnly; SameSite=Lax')
  assert.equal(kept, 'sessionid=abc; Path=/; HttpOnly')
})

test('isRewritableContentType: text and code yes, streams and binaries no', () => {
  assert.equal(isRewritableContentType('text/html; charset=utf-8'), true)
  assert.equal(isRewritableContentType('application/javascript'), true)
  assert.equal(isRewritableContentType('application/json'), true)
  assert.equal(isRewritableContentType('text/css'), true)
  assert.equal(isRewritableContentType('text/event-stream'), false)
  assert.equal(isRewritableContentType('image/png'), false)
  assert.equal(isRewritableContentType(undefined), false)
})

test('corridorEnabled: on by default, config corridor:false turns it off, junk tolerated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'webseek-corridor-'))
  setStateDir(dir)
  assert.equal(corridorEnabled(), true, 'no config file → enabled')
  writeFileSync(join(stateDir(), 'config.json'), '{"corridor":false}\n')
  assert.equal(corridorEnabled(), false)
  writeFileSync(join(stateDir(), 'config.json'), '{"corridor":"yes"}\n')
  assert.equal(corridorEnabled(), true, 'anything but literal false → enabled')
})

test('corridor constants: fixed port and identity contract', () => {
  assert.equal(typeof CORRIDOR_PORT, 'number')
  assert.ok(CORRIDOR_PORT > 1024 && CORRIDOR_PORT < 65536)
  assert.equal(IDENT_PATH.startsWith('/'), true)
})
