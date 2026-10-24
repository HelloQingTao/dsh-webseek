import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { buildImportEvents, validateImportBody, setStateDir, stateDir } from '../lib/index.js'
import { validateHandoffBody, handoffTranscript, HANDOFF_TEMPLATES, guestProxyMode } from '../lib/index.js'

const U = (text) => ({ role: 'user', text })
const A = (text) => ({ role: 'assistant', text })

test('buildImportEvents: contiguous seq, surfaceOp on surface messages, title tail', () => {
  const events = buildImportEvents([U('你好'), A('需要什么帮助？')], '探针会话')
  // header is not part of the event stream; events start at seq 0
  assert.equal(events[0].seq, 0)
  events.forEach((event, index) => assert.equal(event.seq, index, 'seq must be contiguous from 0'))
  const kinds = events.map((event) => event.type)
  assert.deepEqual(kinds.filter((k) => k === 'turn/start'), ['turn/start', 'turn/start'])
  assert.deepEqual(kinds.slice(-2), ['session/end-seed', 'session/title'])
  for (const event of events) {
    if (event.type === 'user/message' || event.type === 'assistant/message') {
      assert.equal(event.surfaceOp, 'append', 'surface messages must carry surfaceOp:"append"')
    } else {
      assert.equal(event.surfaceOp, undefined)
    }
  }
  const title = events.at(-1)
  assert.equal(title.data.title, '探针会话')
  assert.ok(Array.isArray(title.data.messageSeqs))
})

test('buildImportEvents: truncates over-long titles to 80 chars', () => {
  const events = buildImportEvents([U('x')], '长'.repeat(120))
  assert.equal(events.at(-1).data.title.length, 80)
})

test('validateImportBody: accepts a good body, rejects bad ones with a string', () => {
  const good = validateImportBody({ conversationId: 'c1', title: 't', messages: [U('hi')], workspaceId: 'w1' })
  assert.equal(typeof good, 'object')
  assert.equal(good.conversationId, 'c1')
  assert.ok(typeof validateImportBody(null) === 'string')
  assert.ok(typeof validateImportBody({ conversationId: 'c1', messages: [] }) === 'string')
  assert.ok(typeof validateImportBody({ conversationId: 'c1', messages: [U('')], workspaceId: 'w' }) === 'string')
})

test('validateHandoffBody: defaults kind to summary, validates messages', () => {
  const value = validateHandoffBody({ conversationId: 'c1', messages: [U('问'), A('答')], workspaceId: 'w1' })
  assert.equal(value.kind, 'summary')
  assert.equal(value.title, 'c1', 'title falls back to conversationId')
  assert.equal(validateHandoffBody({ conversationId: 'c1', messages: [U('x')], workspaceId: 'w1', template: 'plan' }).kind, 'plan')
  assert.ok(typeof validateHandoffBody({ messages: [U('x')] }) === 'string')
  assert.ok(typeof validateHandoffBody({ conversationId: 'c1', messages: [{ role: 'system', text: 'x' }], workspaceId: 'w1' }) === 'string')
})

test('handoffTranscript: U/A prefixes and blank-line joins', () => {
  const text = handoffTranscript([U('你好'), A('你好，需要什么帮助?')])
  assert.equal(text, 'U: 你好\n\nA: 你好，需要什么帮助?')
  assert.equal(handoffTranscript(undefined), '')
})

test('hand-off templates: summary asks the model to summarize first, not start working', () => {
  const text = HANDOFF_TEMPLATES.summary('t', 'U: x')
  assert.ok(text.includes('总结完成后等我确认，不要直接开工'))
  assert.ok(HANDOFF_TEMPLATES.implement('t', 'U: x').includes('按结论实现'))
  assert.ok(HANDOFF_TEMPLATES.plan('t', 'U: x').includes('分步计划'))
})

test('guestProxyMode: defaults to direct, honours explicit system, survives junk', () => {
  const prev = stateDir()
  const dir = mkdtempSync(join(os.tmpdir(), 'webseek-test-'))
  setStateDir(dir)
  try {
    // no config file at all
    assert.equal(guestProxyMode(), 'direct')
    // explicit system
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ guestProxy: 'system' }))
    assert.equal(guestProxyMode(), 'system')
    // junk values fall back to direct
    writeFileSync(join(dir, 'config.json'), '{guestProxy: broken json')
    assert.equal(guestProxyMode(), 'direct')
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ guestProxy: 'surprise' }))
    assert.equal(guestProxyMode(), 'direct')
  } finally {
    setStateDir(prev)
  }
})
