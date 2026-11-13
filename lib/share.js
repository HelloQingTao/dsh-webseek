/**
 * dsh-webseek — share-link import, pure half.
 *
 * The web app can share a conversation as a public link
 * (`https://chat.deepseek.com/share/<id>`). The page behind that link is a
 * normal SPA that reads the conversation from one API:
 *
 *   GET https://chat.deepseek.com/api/v0/share/content?share_id=<id>
 *   → { data: { biz_code, biz_data: { title, model_type, messages[] } } }
 *
 * The API needs no login — a shared conversation is public — but it does need
 * a browser-shaped User-Agent (the edge answers a bare client with its own
 * error page instead of JSON).
 *
 * Everything here is pure so it can be unit-tested offline: the id check, the
 * main-line walk (a shared conversation is a *tree* of regenerated branches,
 * and the web app shows only the first-child path), and the mapping onto DSH
 * messages.
 */

/** The share content endpoint the web app uses. */
export const SHARE_CONTENT_URL = 'https://chat.deepseek.com/api/v0/share/content'

/** The host that hosts share links; nothing else is accepted as a source. */
const SHARE_HOST = 'chat.deepseek.com'

/** What a share id may look like (the path segment of a share URL). */
const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/

/** Upper bound on a fetched share body; a shared conversation is far smaller. */
export const SHARE_BODY_LIMIT = 2 * 1024 * 1024

/**
 * Pull the share id out of what the user pasted.
 *
 * Only two shapes are accepted: a bare id, or a `chat.deepseek.com/share/<id>`
 * URL. The host and path of a pasted URL are never used to build the request
 * — the request URL is always assembled from the fixed endpoint above, so a
 * pasted link can never point the fetch somewhere else.
 * @param {unknown} input - a share URL or a bare id.
 * @returns {string|null} the share id, or null when the input is not a share link.
 */
export function parseShareId(input) {
  if (typeof input !== 'string') return null
  const text = input.trim()
  if (text === '') return null
  if (SHARE_ID_PATTERN.test(text)) return text
  let url
  try {
    url = new URL(text)
  } catch (error) {
    return null
  }
  if (url.hostname.toLowerCase() !== SHARE_HOST) return null
  const parts = url.pathname.split('/').filter((part) => part !== '')
  if (parts.length !== 2 || parts[0] !== 'share') return null
  let id
  try {
    id = decodeURIComponent(parts[1])
  } catch (error) {
    return null // a malformed escape is not a share link
  }
  return SHARE_ID_PATTERN.test(id) ? id : null
}

/**
 * The main line of a shared conversation.
 *
 * Shared messages form a tree: a regenerated answer is a *sibling* of the
 * answer it replaced, linked through `parent_id`. The web app keeps the first
 * child of every node (`currentChildIndex: 0`), so that is the line a reader
 * sees — and the line worth importing. Walking it here keeps abandoned
 * branches out and preserves the original order.
 * @param {unknown[]} messages - `biz_data.messages`.
 * @returns {object[]} the messages on the main line, in order.
 */
export function pickMainLine(messages) {
  if (!Array.isArray(messages)) return []
  const nodes = messages.filter((message) => message !== null && typeof message === 'object')
  const children = new Map()
  for (const message of nodes) {
    const parent = message.parent_id === undefined || message.parent_id === null ? null : String(message.parent_id)
    const key = parent === null ? '' : parent
    const bucket = children.get(key)
    if (bucket === undefined) children.set(key, [message])
    else bucket.push(message)
  }
  const roots = children.get('') ?? []
  if (roots.length === 0) return []
  const line = []
  const seen = new Set()
  let current = roots[0]
  while (current !== undefined && current !== null) {
    const id = String(current.message_id)
    if (seen.has(id)) break // a malformed share must not spin
    seen.add(id)
    line.push(current)
    const bucket = children.get(id)
    current = bucket === undefined ? undefined : bucket[0]
  }
  return line
}

/**
 * The text of one fragment type inside a message.
 * @param {object} message - a share message.
 * @param {string} type - the fragment type to collect.
 * @returns {string} the joined text, trimmed.
 */
function fragmentText(message, type) {
  const fragments = Array.isArray(message.fragments) ? message.fragments : []
  return fragments
    .filter((fragment) => fragment !== null && typeof fragment === 'object' && String(fragment.type).toUpperCase() === type)
    .map((fragment) => (typeof fragment.content === 'string' ? fragment.content : ''))
    .map((text) => text.trim())
    .filter((text) => text !== '')
    .join('\n\n')
}

/**
 * Map the main line of a shared conversation onto DSH messages.
 *
 * A user turn is a `REQUEST` fragment, an assistant turn a `RESPONSE`
 * fragment, and a `THINK` fragment is the model's reasoning — kept in front of
 * the answer so the imported transcript still reads like the web one. Every
 * other fragment type (files, tool calls, templates) has no DSH counterpart
 * and is dropped.
 * @param {unknown[]} messages - `biz_data.messages`.
 * @returns {{role: 'user'|'assistant', text: string}[]} the importable messages.
 */
export function mapShareMessages(messages) {
  const line = pickMainLine(messages)
  const mapped = []
  for (const message of line) {
    const role = String(message.role ?? '').toUpperCase()
    if (role === 'USER') {
      const text = fragmentText(message, 'REQUEST')
      if (text !== '') mapped.push({ role: 'user', text })
      continue
    }
    if (role === 'ASSISTANT') {
      const thinking = fragmentText(message, 'THINK')
      const answer = fragmentText(message, 'RESPONSE')
      if (answer === '' && thinking === '') continue
      const text = thinking === '' ? answer : answer === '' ? '[思考] ' + thinking : '[思考] ' + thinking + '\n\n' + answer
      mapped.push({ role: 'assistant', text })
    }
  }
  return mapped
}

/**
 * The title of a shared conversation, with a fallback.
 * @param {unknown} title - `biz_data.title`.
 * @returns {string} the title to give the imported session.
 */
export function shareTitle(title) {
  if (typeof title !== 'string') return '导入的网页会话'
  const trimmed = title.trim()
  return trimmed === '' ? '导入的网页会话' : trimmed
}
