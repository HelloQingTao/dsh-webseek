import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, readFileSync } from 'node:fs'
import {
  buildImportEvents, compareVersions, evaluateShareResponse, evaluateVersionResponse,
  PLUGIN_VERSION, setStateDir, stateDir, validateShareImportBody,
} from '../lib/index.js'

const U = (text) => ({ role: 'user', text })
const A = (text) => ({ role: 'assistant', text })

test('buildImportEvents: contiguous seq, surfaceOp on surface messages, title tail', () => {
  const events = buildImportEvents([U('你好'), A('需要什么帮助？')], '探针会话')
  // header is not part of the event stream; events start at seq 0
  assert.equal(events[0].seq, 0)
  events.forEach((event, index) => assert.equal(event.seq, index, 'seq must be contiguous from 0'))
  const kinds = events.map((event) => event.type)
  // One turn per question, and the answer lives in that same turn: DSH writes
  // turn/start → step/start → user/message → assistant/message → step/end →
  // turn/end, and an answer in a turn of its own is dropped by the fold.
  assert.deepEqual(kinds.filter((k) => k === 'turn/start'), ['turn/start'])
  assert.deepEqual(kinds, [
    'turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end',
    'session/title', 'session/end-seed',
  ])
  const assistant = events.find((event) => event.type === 'assistant/message')
  const step = events.find((event) => event.type === 'step/start')
  assert.equal(assistant.data.turn, step.data.turn, 'the answer must sit in the turn of its question')
  assert.equal(assistant.data.step, step.data.step)
  // `session/end-seed` closes the seeded history: it is the last event.
  assert.deepEqual(kinds.slice(-2), ['session/title', 'session/end-seed'])
  for (const event of events) {
    if (event.type === 'user/message' || event.type === 'assistant/message') {
      assert.equal(event.surfaceOp, 'append', 'surface messages must carry surfaceOp:"append"')
    } else {
      assert.equal(event.surfaceOp, undefined)
    }
  }
  const title = events.find((event) => event.type === 'session/title')
  assert.equal(title.data.title, '探针会话')
  assert.ok(Array.isArray(title.data.messageSeqs))
  const user = events.find((event) => event.type === 'user/message')
  assert.deepEqual(title.data.messageSeqs, [user.seq], 'the title cites the first user message')
})

test('buildImportEvents: a question without an answer still closes its turn', () => {
  const events = buildImportEvents([U('没人回答'), U('下一个问题')], '半截会话')
  const kinds = events.map((event) => event.type)
  assert.deepEqual(kinds.filter((k) => k === 'turn/start'), ['turn/start', 'turn/start'])
  assert.equal(kinds.filter((k) => k === 'assistant/message').length, 0)
  assert.equal(kinds.filter((k) => k === 'turn/end').length, 2)
})

test('buildImportEvents: truncates over-long titles to 80 chars', () => {
  const events = buildImportEvents([U('x')], '长'.repeat(120))
  const title = events.find((event) => event.type === 'session/title')
  assert.equal(title.data.title.length, 80)
})

test('validateShareImportBody: takes the id out of a link, refuses anything else', () => {
  const good = validateShareImportBody({ shareUrl: 'https://chat.deepseek.com/share/4qjbnqq00rr6i23zhm', workspaceId: 'w1' })
  assert.equal(good.shareId, '4qjbnqq00rr6i23zhm')
  assert.equal(good.workspaceId, 'w1')
  assert.equal(validateShareImportBody({ shareId: '4qjbnqq00rr6i23zhm', workspaceId: 'w1' }).shareId, '4qjbnqq00rr6i23zhm')
  assert.ok(typeof validateShareImportBody(null) === 'string')
  assert.ok(typeof validateShareImportBody({ shareUrl: 'nope', workspaceId: 'w1' }) === 'string')
  assert.ok(typeof validateShareImportBody({ shareUrl: 'https://evil.example/share/4qjbnqq00rr6i23zhm', workspaceId: 'w1' }) === 'string')
  assert.ok(typeof validateShareImportBody({ shareUrl: 'https://chat.deepseek.com/share/4qjbnqq00rr6i23zhm' }) === 'string')
})

test('evaluateShareResponse: a rate-limited edge is not a missing share', () => {
  const limited = evaluateShareResponse({ status: 429, contentType: 'text/html', text: '<html>Request blocked</html>' })
  assert.equal(limited.ok, false)
  assert.equal(limited.code, 'rate-limited')
})

test('evaluateShareResponse: an HTML error page is a bad response, not a broken share', () => {
  const html = evaluateShareResponse({ status: 200, contentType: 'text/html; charset=utf-8', text: '<html>Error</html>' })
  assert.equal(html.ok, false)
  assert.equal(html.code, 'bad-response')
  const garbage = evaluateShareResponse({ status: 200, contentType: 'application/json', text: 'not json' })
  assert.equal(garbage.code, 'bad-response')
})

test('evaluateShareResponse: a non-zero biz_code means the share is gone', () => {
  const gone = evaluateShareResponse({
    status: 200,
    contentType: 'application/json',
    text: JSON.stringify({ data: { biz_code: 1, biz_data: null } }),
  })
  assert.equal(gone.ok, false)
  assert.equal(gone.code, 'not-found')
})

test('evaluateShareResponse: a good body yields the title and the mapped messages', () => {
  const good = evaluateShareResponse({
    status: 200,
    contentType: 'application/json',
    text: JSON.stringify({
      data: {
        biz_code: 0,
        biz_data: {
          title: 'Shared Conversation',
          messages: [
            { message_id: 1, parent_id: null, role: 'USER', fragments: [{ type: 'REQUEST', content: 'hi' }] },
            { message_id: 2, parent_id: 1, role: 'ASSISTANT', fragments: [{ type: 'RESPONSE', content: 'hello' }] },
          ],
        },
      },
    }),
  })
  assert.equal(good.ok, true)
  assert.equal(good.title, 'Shared Conversation')
  assert.deepEqual(good.messages, [
    { role: 'user', text: 'hi' },
    { role: 'assistant', text: 'hello' },
  ])
})

test('evaluateShareResponse: a share with nothing importable is empty, not a failure of the endpoint', () => {
  const empty = evaluateShareResponse({
    status: 200,
    contentType: 'application/json',
    text: JSON.stringify({ data: { biz_code: 0, biz_data: { title: 'x', messages: [] } } }),
  })
  assert.equal(empty.ok, false)
  assert.equal(empty.code, 'empty')
})

test('stateDir: the test hook redirects the durable directory', () => {
  const prev = stateDir()
  const dir = mkdtempSync(join(os.tmpdir(), 'webseek-test-'))
  setStateDir(dir)
  try {
    assert.equal(stateDir(), dir)
  } finally {
    setStateDir(prev)
  }
})

test('compareVersions: orders numeric parts, ignores a prerelease suffix', () => {
  assert.equal(compareVersions('0.2.1', '0.2.0'), 1)
  assert.equal(compareVersions('0.2.0', '0.2.0'), 0)
  assert.equal(compareVersions('0.2.0', '0.2.1'), -1)
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1)
  assert.equal(compareVersions('1.0.0', '0.9.9'), 1)
  assert.equal(compareVersions('0.2.0-rc.1', '0.2.0'), 0)
})

test('evaluateVersionResponse: 404 is not-published, 200 yields the verdict', () => {
  assert.deepEqual(evaluateVersionResponse({ status: 404, text: 'Not Found' }, '0.2.0'), { ok: false, code: 'not-published' })
  assert.deepEqual(
    evaluateVersionResponse({ status: 200, text: JSON.stringify({ version: '0.2.0' }) }, '0.2.0'),
    { ok: true, current: '0.2.0', latest: '0.2.0', hasUpdate: false },
  )
  assert.deepEqual(
    evaluateVersionResponse({ status: 200, text: JSON.stringify({ version: '0.3.0' }) }, '0.2.0'),
    { ok: true, current: '0.2.0', latest: '0.3.0', hasUpdate: true },
  )
  assert.equal(evaluateVersionResponse({ status: 500, text: '' }, '0.2.0').code, 'bad-response')
  assert.equal(evaluateVersionResponse({ status: 200, text: 'not json' }, '0.2.0').code, 'bad-response')
  assert.equal(evaluateVersionResponse({ status: 200, text: JSON.stringify({ version: 'weird' }) }, '0.2.0').code, 'bad-response')
})

test('PLUGIN_VERSION equals package.json version', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(PLUGIN_VERSION, pkg.version)
})

test('client footer: VERSION matches package.json and both locales carry the footer copy', () => {
  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const version = client.match(/const VERSION = '([^']+)'/)
  assert.ok(version, 'client declares a VERSION constant')
  assert.equal(version[1], pkg.version)
  const keys = ['footer.feedback', 'footer.check', 'footer.checking', 'footer.latest', 'footer.updateAvailable', 'footer.notPublished', 'footer.checkFailed']
  for (const key of keys) {
    const hits = client.split("'" + key + "':").length - 1
    assert.equal(hits, 2, 'footer key ' + key + ' must be defined in both zh and en')
  }
})
