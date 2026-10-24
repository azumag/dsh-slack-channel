// SlackClient tests against a local mock Web API server.

import { test, assert, equal, startMockSlack } from './_util.mjs'
import { SlackApiError, SlackClient, splitMessage } from '../src/slack.js'

test('call unwraps the ok body without the ok field', async () => {
  const mock = await startMockSlack()
  try {
    const client = new SlackClient({ apiBase: mock.url, botToken: 'xoxb-t', appToken: 'xapp-t' })
    const result = await client.postMessage('C1', 'hello')
    equal(result.channel, 'C1')
    assert(result.ok === undefined, 'ok stripped from result')
    const sent = mock.calls.find((c) => c.method === 'chat.postMessage')
    equal(sent.token, 'xoxb-t', 'bot token used for postMessage')
    equal(sent.body.text, 'hello')
  } finally {
    await mock.close()
  }
})

test('apps.connections.open requires the app token', async () => {
  const mock = await startMockSlack()
  try {
    const client = new SlackClient({ apiBase: mock.url, botToken: 'xoxb-t', appToken: 'xapp-t' })
    const opened = await client.openConnections()
    assert(opened.url.startsWith('wss://'), 'url minted')
    let caught
    try { await client.call('apps.connections.open', 'xoxb-wrong') } catch (error) { caught = error }
    assert(caught instanceof SlackApiError && caught.slackError === 'invalid_auth', 'bot token rejected for socket open')
  } finally {
    await mock.close()
  }
})

test('ok:false bodies map to SlackApiError with the slack error', async () => {
  const mock = await startMockSlack()
  try {
    mock.setHandler((method) => method === 'chat.postMessage'
      ? { status: 200, reply: { ok: false, error: 'channel_not_found' } }
      : undefined)
    const client = new SlackClient({ apiBase: mock.url, botToken: 'xoxb-t', appToken: 'xapp-t' })
    let caught
    try { await client.postMessage('C404', 'x') } catch (error) { caught = error }
    assert(caught instanceof SlackApiError, 'expected SlackApiError, got ' + caught)
    equal(caught.slackError, 'channel_not_found')
  } finally {
    await mock.close()
  }
})

test('429 surfaces Retry-After header as retryAfterMs', async () => {
  const mock = await startMockSlack()
  try {
    mock.setHandler((method) => method === 'chat.postMessage'
      ? { status: 429, reply: { ok: false, retryAfterSec: 3 } }
      : undefined)
    const client = new SlackClient({ apiBase: mock.url, botToken: 'xoxb-t', appToken: 'xapp-t' })
    let caught
    try { await client.postMessage('C1', 'x') } catch (error) { caught = error }
    assert(caught instanceof SlackApiError && caught.status === 429, '429 mapped')
    equal(caught.retryAfterMs, 3000, 'header seconds converted to ms')
  } finally {
    await mock.close()
  }
})

test('postMessage honors one 429 retry then succeeds', async () => {
  const mock = await startMockSlack()
  try {
    let posts = 0
    mock.setHandler((method) => {
      if (method !== 'chat.postMessage') return undefined
      posts++
      if (posts === 1) return { status: 429, reply: { ok: false, retryAfterSec: 0 } }
      return undefined
    })
    const client = new SlackClient({ apiBase: mock.url, botToken: 'xoxb-t', appToken: 'xapp-t' })
    const sent = await client.postMessage('C1', 'retry me', { threadTs: '123.456' })
    assert(sent.ts !== undefined, 'posted after retry')
    const bodies = mock.calls.filter((c) => c.method === 'chat.postMessage')
    equal(bodies.length, 2, 'one retry after 429')
    equal(bodies[0].body.thread_ts, '123.456', 'thread_ts passed')
  } finally {
    await mock.close()
  }
})

test('reactions swallow failures but report already_reacted as success', async () => {
  const mock = await startMockSlack()
  try {
    mock.setHandler((method) => method === 'reactions.add'
      ? { status: 200, reply: { ok: false, error: 'already_reacted' } }
      : undefined)
    const client = new SlackClient({ apiBase: mock.url, botToken: 'xoxb-t', appToken: 'xapp-t' })
    equal(await client.react('C1', '123.4', 'hourglass'), true, 'already_reacted counts as success')
    equal(await client.unreact('C1', '123.4', 'hourglass'), true)
  } finally {
    await mock.close()
  }
})

test('splitMessage chunks reconstruct the input', () => {
  const NL = String.fromCharCode(10)
  const text = Array.from({ length: 40 }, (_, i) => 'line ' + i + ' ' + 'x'.repeat(25)).join(NL)
  const chunks = splitMessage(text, 150)
  assert(chunks.length > 1, 'multiple chunks')
  for (const chunk of chunks) assert(chunk.length <= 150, 'chunk over limit')
  equal(chunks.join(''), text, 'reconstruction')
})

test('replies follows the cursor, drops the parent each page repeats, and stops at maxPages', async () => {
  const mock = await startMockSlack()
  try {
    const root = { ts: '100.000001', text: 'root' }
    mock.setHandler((method, body) => {
      if (method !== 'conversations.replies') return undefined
      if (body.cursor === undefined) return { reply: { ok: true, messages: [root, { ts: '100.000002', text: 'a' }], has_more: true, response_metadata: { next_cursor: 'c2' } } }
      return { reply: { ok: true, messages: [root, { ts: '100.00000' + (body.cursor === 'c2' ? 3 : 4), text: body.cursor }], has_more: body.cursor === 'c2', response_metadata: { next_cursor: body.cursor === 'c2' ? 'c3' : '' } } }
    })
    const client = new SlackClient({ apiBase: mock.url, botToken: 'xoxb-t', appToken: 'xapp-t' })
    const all = await client.replies('C1', root.ts, { latest: '200.000000' })
    equal(all.map((m) => m.text), ['root', 'a', 'c2', 'c3'], 'every page, parent once')
    const calls = mock.calls.filter((c) => c.method === 'conversations.replies')
    equal(calls.map((c) => c.body.cursor ?? null), [null, 'c2', 'c3'])
    equal([calls[0].body.channel, calls[0].body.ts, calls[0].body.latest, calls[0].token], ['C1', root.ts, '200.000000', 'xoxb-t'])
    const capped = await client.replies('C1', root.ts, { maxPages: 2 })
    equal(capped.map((m) => m.text), ['root', 'a', 'c2'], 'maxPages bounds the walk')
  } finally {
    await mock.close()
  }
})
