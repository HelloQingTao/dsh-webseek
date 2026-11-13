import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { mapShareMessages, parseShareId, pickMainLine, shareTitle } from '../lib/share.js'

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL('./share-fixture.json', import.meta.url)), 'utf8'))
const fixtureMessages = fixture.data.biz_data.messages

test('parseShareId: a bare id is taken as is', () => {
  assert.equal(parseShareId('4qjbnqq00rr6i23zhm'), '4qjbnqq00rr6i23zhm')
  assert.equal(parseShareId('  4qjbnqq00rr6i23zhm  '), '4qjbnqq00rr6i23zhm')
})

test('parseShareId: a share URL yields its path segment', () => {
  assert.equal(parseShareId('https://chat.deepseek.com/share/4qjbnqq00rr6i23zhm'), '4qjbnqq00rr6i23zhm')
  assert.equal(parseShareId('http://chat.deepseek.com/share/4qjbnqq00rr6i23zhm?x=1'), '4qjbnqq00rr6i23zhm')
})

test('parseShareId: anything else is refused', () => {
  assert.equal(parseShareId(''), null)
  assert.equal(parseShareId('   '), null)
  assert.equal(parseShareId('not a link'), null)
  assert.equal(parseShareId('https://evil.example/share/4qjbnqq00rr6i23zhm'), null)
  assert.equal(parseShareId('https://chat.deepseek.com/chat/4qjbnqq00rr6i23zhm'), null)
  assert.equal(parseShareId('https://chat.deepseek.com/share/'), null)
  assert.equal(parseShareId('https://chat.deepseek.com/share/short'), null)
  assert.equal(parseShareId(null), null)
  assert.equal(parseShareId(42), null)
})

test('pickMainLine: the real share keeps its order', () => {
  const line = pickMainLine(fixtureMessages)
  assert.equal(line.length, fixtureMessages.length)
  assert.equal(line[0].message_id, fixtureMessages[0].message_id)
})

test('pickMainLine: a regenerated branch is left out, the first child wins', () => {
  const tree = [
    { message_id: 1, parent_id: null },
    { message_id: 2, parent_id: 1 },
    { message_id: 3, parent_id: 1 }, // the regenerated sibling
    { message_id: 4, parent_id: 2 },
  ]
  const line = pickMainLine(tree)
  assert.deepEqual(line.map((message) => message.message_id), [1, 2, 4])
})

test('pickMainLine: malformed input cannot loop forever', () => {
  assert.deepEqual(pickMainLine([]), [])
  assert.deepEqual(pickMainLine(null), [])
  const cyclic = [
    { message_id: 1, parent_id: 2 },
    { message_id: 2, parent_id: 1 },
  ]
  assert.ok(pickMainLine(cyclic).length <= 2)
})

test('mapShareMessages: the real share maps to one user and one assistant turn', () => {
  const mapped = mapShareMessages(fixtureMessages)
  assert.equal(mapped.length, 2)
  assert.equal(mapped[0].role, 'user')
  assert.equal(mapped[1].role, 'assistant')
  assert.ok(mapped[0].text.length > 0)
  assert.ok(mapped[1].text.length > 0)
})

test('mapShareMessages: THINK is kept in front of the answer', () => {
  const mapped = mapShareMessages([
    { message_id: 1, parent_id: null, role: 'USER', fragments: [{ type: 'REQUEST', content: 'hi' }] },
    {
      message_id: 2,
      parent_id: 1,
      role: 'ASSISTANT',
      fragments: [
        { type: 'THINK', content: 'thinking' },
        { type: 'RESPONSE', content: 'answer' },
        { type: 'FILE', content: 'ignored' },
      ],
    },
  ])
  assert.equal(mapped.length, 2)
  assert.equal(mapped[1].text, '[思考] thinking\n\nanswer')
})

test('mapShareMessages: empty turns are dropped', () => {
  const mapped = mapShareMessages([
    { message_id: 1, parent_id: null, role: 'USER', fragments: [] },
    { message_id: 2, parent_id: 1, role: 'ASSISTANT', fragments: [{ type: 'RESPONSE', content: '  ' }] },
  ])
  assert.deepEqual(mapped, [])
})

test('shareTitle: falls back when the share has no title', () => {
  assert.equal(shareTitle('Shared Conversation'), 'Shared Conversation')
  assert.equal(shareTitle('  '), '导入的网页会话')
  assert.equal(shareTitle(undefined), '导入的网页会话')
})
