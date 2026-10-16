// End-to-end interactive tests: apply() with the real Socket Mode loop, a mock
// Slack Web API and a fake agents registry. An approval or ask_user_question
// request raised by a channel-owned agent must reach Slack, be answerable
// there (button, command, or plain text), and always settle — the regression
// this suite exists for is a prompt that held the turn (and every later
// message) until the host restarted.

import { test, assert, equal, startMockSlack, sleep, waitFor, FakeSlackSocket, blockKitViolation } from './_util.mjs'
import { apply, Config } from '../src/index.js'
import { ACTION_APPROVAL_ALLOW, isQuestionOptionAction } from '../src/interactions.js'

class FakeAgent {
  constructor(id) {
    this.id = id
    this.session = { id, header: { id } }
    this.followups = []
    this.cancels = []
    this.turn = 0
    this.onEvent = undefined
  }

  followup(message) {
    this.followups.push(message)
  }

  cancel(cause, options) {
    this.cancels.push({ cause, options })
  }

  complete(text, kind = 'completed') {
    const turn = ++this.turn
    this.onEvent?.({ type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text }] } } })
    this.onEvent?.({ type: 'turn/end', data: { turn, reason: { kind } } })
  }
}

function makeCtx() {
  const listeners = {}
  const effects = []
  const logs = []
  const ctx = {
    logger: () => ({
      info: () => {},
      warn: (...a) => logs.push('warn ' + a.join(' ')),
      error: (...a) => logs.push('error ' + a.join(' ')),
    }),
    on(event, fn) {
      ;(listeners[event] ??= []).push(fn)
      return () => {
        const at = listeners[event].indexOf(fn)
        if (at >= 0) listeners[event].splice(at, 1)
      }
    },
    effect(fn, label) { effects.push(fn) },
    get: () => undefined,
    agents: undefined,
    __listeners: listeners,
  }
  return { ctx, listeners, effects, logs }
}

function emit(ctx, event, ...args) {
  for (const fn of [...(ctx.__listeners[event] ?? [])]) fn(...args)
}

/** Mount apply() against the mock Web API and the scripted socket. */
async function mount(mock, configOverrides = {}) {
  const { ctx, listeners, effects, logs } = makeCtx()
  const created = []
  ctx.agents = {
    async create(options) {
      const agent = new FakeAgent(options.sessionId)
      agent.onEvent = (event) => emit(ctx, 'session/event', agent.session, event)
      created.push(agent)
      return { agent, dispose: async () => {} }
    },
    async resume() { throw new Error('persistence not configured in test') },
    get: () => undefined,
  }
  const h = {
    ctx, created, logs, listeners,
    sockets: [],
    envelopeCounter: 0,
    push(event) {
      h.envelopeCounter += 1
      h.sockets[0]?.receive({ envelope_id: 'e-' + h.envelopeCounter, type: 'events_api', payload: { event } })
    },
    /** Deliver one interactive (Block Kit) envelope on the live socket. */
    pushInteractive(payload) {
      h.envelopeCounter += 1
      h.sockets[0]?.receive({ envelope_id: 'i-' + h.envelopeCounter, type: 'interactive', payload })
    },
    sent() { return mock.calls.filter((c) => c.method === 'chat.postMessage').map((c) => c.body) },
    updates() { return mock.calls.filter((c) => c.method === 'chat.update').map((c) => c.body) },
    /** Drive the plugin's waterfall chain exactly as cordis dispatches it. */
    waterfall(event, request, tail = () => Promise.resolve(undefined)) {
      const chain = [...(listeners[event] ?? [])]
      const run = (index) => (chain[index] ?? tail)(request, () => run(index + 1))
      return run(0)
    },
    async dispose() {
      const body = effects[effects.length - 1]
      await body()()
    },
  }
  const config = {
    botToken: 'xoxb-test',
    appToken: 'xapp-test',
    apiBase: mock.url,
    allowedChannelIds: ['C42'],
    socketRetryDelayMs: 20,
    retryDelayMs: 50,
    // Short deadlines keep the suite fast; the default is 30 minutes.
    interactiveTimeoutMs: 400,
    ...configOverrides,
  }
  const validated = Config['~standard'].validate(config)
  assert(validated.issues === undefined, 'mount config invalid: ' + JSON.stringify(validated.issues))
  const configValue = validated.value
  configValue.wsFactory = async () => {
    const socket = new FakeSlackSocket()
    h.sockets.push(socket)
    return socket
  }
  apply(ctx, configValue)
  await waitFor(() => h.sockets.length > 0 && h.sockets[0].listeners.message?.length > 0)
  return h
}

function messageEvent(channel, text, extra = {}) {
  return { type: 'message', channel, user: 'U1', text, ts: '1700000001.001', ...extra }
}

/** One agent with a live record, created by posting a channel message. */
async function startSession(h, channel = 'C42') {
  h.push(messageEvent(channel, 'hello'))
  await waitFor(() => h.created.length === 1)
  return h.created[0]
}

const NEVER = () => new Promise(() => {})

test('an approval request is posted to Slack and a button decides it', async () => {
  const mock = await startMockSlack()
  try {
    const h = await mount(mock)
    const agent = await startSession(h)
    const outcome = h.waterfall('approval/request', { agent, toolName: 'bash', reason: 'escalate sandbox' }, NEVER)
    const prompt = await waitFor(() => h.sent().find((body) => Array.isArray(body.blocks)))
    equal(prompt.channel, 'C42', 'the prompt lands in the channel')
    equal(prompt.thread_ts, '1700000001.001', 'and in the turn thread')
    const allow = prompt.blocks.flatMap((block) => block.elements ?? []).find((element) => element.action_id === ACTION_APPROVAL_ALLOW)
    assert(allow !== undefined, 'the Allow button is on the message')

    h.pushInteractive({
      type: 'block_actions',
      channel: { id: 'C42' },
      user: { id: 'U1' },
      actions: [{ action_id: ACTION_APPROVAL_ALLOW, value: allow.value }],
    })
    equal(await outcome, 'allowed-once', 'the click decides the approval')
    await waitFor(() => h.updates().length === 1)
    assert(h.updates()[0].blocks.some((block) => block.type === 'actions') === false, 'the buttons are retired')
    await h.dispose()
  } finally {
    await mock.close()
  }
})

test('!allow, !deny and !answer answer prompts from channel text', async () => {
  const mock = await startMockSlack()
  try {
    const h = await mount(mock)
    const agent = await startSession(h)

    const approval = h.waterfall('approval/request', { agent, toolName: 'bash' }, NEVER)
    await waitFor(() => h.sent().some((body) => Array.isArray(body.blocks)))
    h.push(messageEvent('C42', '!allow', { ts: '1700000002.001' }))
    equal(await approval, 'allowed-once', '!allow decides the approval')

    const question = h.waterfall('user-questions/request', {
      agent,
      questions: [{ id: 'a', question: 'Deploy?', options: [{ label: 'Yes' }, { label: 'No' }] }],
    }, NEVER)
    await waitFor(() => h.sent().filter((body) => Array.isArray(body.blocks)).length === 2)
    h.push(messageEvent('C42', '!answer go ahead', { ts: '1700000003.001' }))
    equal((await question).answers, [{ id: 'a', selected: [], custom: 'go ahead' }], '!answer carries free text')
    await h.dispose()
  } finally {
    await mock.close()
  }
})

test('a question prompt is answered by its option buttons', async () => {
  const mock = await startMockSlack()
  try {
    const h = await mount(mock)
    const agent = await startSession(h)
    const answer = h.waterfall('user-questions/request', {
      agent,
      questions: [{ id: 'a', header: 'Confirm', question: 'Deploy?', options: [{ label: 'Yes' }, { label: 'No' }] }],
    }, NEVER)
    const prompt = await waitFor(() => h.sent().find((body) => Array.isArray(body.blocks)))
    const yes = prompt.blocks.flatMap((block) => block.elements ?? []).find((element) => isQuestionOptionAction(element.action_id))
    h.pushInteractive({
      type: 'block_actions',
      channel: { id: 'C42' },
      user: { id: 'U1' },
      actions: [{ action_id: yes.action_id, value: yes.value }],
    })
    equal((await answer).answers, [{ id: 'a', selected: ['Yes'] }], 'the button answers the batch')
    await h.dispose()
  } finally {
    await mock.close()
  }
})

// The batch DSH asked on 2026-10-17 03:06 JST, which Slack refused because
// all four option buttons shared one action_id.
test('a four-option question with descriptions reaches Slack and is answered', async () => {
  const mock = await startMockSlack()
  try {
    const h = await mount(mock)
    const agent = await startSession(h)
    const answer = h.waterfall('user-questions/request', {
      agent,
      questions: [{
        id: 'next_step',
        header: '次の一手',
        question: '現時点（03:05 JST）では次スロット（03:18）前のため判定できません。どう進めますか？',
        options: [
          { label: '03:18以降に read-only diagnostics を再実行する（推奨）', description: 'workflow run は1件作成（本番変更なし）。' },
          { label: '報告のみでよい（追加実行しない）', description: '再実行はオーナーが行います。' },
          { label: '未マージ2ブランチの調査を先に進める', description: '差分を read-only で調べます。' },
          { label: 'handoff.md に本検証結果を追記する', description: '実測値・未確認事項を追記します。' },
        ],
      }],
    }, NEVER)
    const prompt = await waitFor(() => h.sent().find((body) => Array.isArray(body.blocks)))
    equal(blockKitViolation(prompt.blocks), undefined, 'Slack accepts the prompt')
    const buttons = prompt.blocks.flatMap((block) => block.elements ?? []).filter((element) => isQuestionOptionAction(element.action_id))
    equal(buttons.length, 4, 'one button per option')
    h.pushInteractive({
      type: 'block_actions',
      channel: { id: 'C42' },
      user: { id: 'U1' },
      actions: [{ action_id: buttons[2].action_id, value: buttons[2].value }],
    })
    equal((await answer).answers, [{ id: 'next_step', selected: ['未マージ2ブランチの調査を先に進める'] }], 'the third button answers')
    await h.dispose()
  } finally {
    await mock.close()
  }
})

test('a plain message answers an option-less question', async () => {
  const mock = await startMockSlack()
  try {
    const h = await mount(mock)
    const agent = await startSession(h)
    const answer = h.waterfall('user-questions/request', { agent, questions: [{ id: 'a', question: 'Which branch?' }] }, NEVER)
    await waitFor(() => h.sent().some((body) => Array.isArray(body.blocks)))
    h.push(messageEvent('C42', 'feature/x', { ts: '1700000004.001' }))
    equal((await answer).answers, [{ id: 'a', selected: [], custom: 'feature/x' }], 'the message becomes the answer')
    // The message must not also drive a turn: the session stays as it was.
    equal(agent.followups.length, 1, 'no extra turn was queued')
    await h.dispose()
  } finally {
    await mock.close()
  }
})

test('an unanswered prompt expires instead of blocking the channel', async () => {
  const mock = await startMockSlack()
  try {
    const h = await mount(mock, { interactiveTimeoutMs: 60 })
    const agent = await startSession(h)
    const outcome = await h.waterfall('approval/request', { agent, toolName: 'bash' }, NEVER)
    equal(outcome, 'unavailable', 'the deadline fails the approval closed')
    await waitFor(() => h.updates().length === 1)

    // The turn can now finish and the channel takes work again.
    agent.complete('done')
    h.push(messageEvent('C42', 'still there?', { ts: '1700000005.001' }))
    await waitFor(() => agent.followups.length === 2)
    await h.dispose()
  } finally {
    await mock.close()
  }
})

test('a foreign agent delegates instead of prompting the channel', async () => {
  const mock = await startMockSlack()
  try {
    const h = await mount(mock)
    await startSession(h)
    let delegated = 0
    const outcome = await h.waterfall(
      'approval/request',
      { agent: { session: { id: 'not-ours' } }, toolName: 'bash' },
      () => { delegated += 1; return Promise.resolve('rejected') },
    )
    equal(outcome, 'rejected', 'the downstream decision is returned')
    equal(delegated, 1, 'next() was reached')
    equal(h.sent().filter((body) => Array.isArray(body.blocks)).length, 0, 'no prompt was posted for a foreign agent')
    await h.dispose()
  } finally {
    await mock.close()
  }
})

test('teardown settles a prompt that is still waiting', async () => {
  const mock = await startMockSlack()
  try {
    const h = await mount(mock, { interactiveTimeoutMs: 0 })
    const agent = await startSession(h)
    const outcome = h.waterfall('approval/request', { agent, toolName: 'bash' }, NEVER)
    await waitFor(() => h.sent().some((body) => Array.isArray(body.blocks)))
    await h.dispose()
    equal(await outcome, 'cancelled', 'teardown releases the pending approval')
  } finally {
    await mock.close()
  }
})

test('a message queued behind a prompt is told what the channel waits for', async () => {
  const mock = await startMockSlack()
  try {
    const h = await mount(mock)
    const agent = await startSession(h) // the fake agent holds turn 1 open
    const outcome = h.waterfall('approval/request', { agent, toolName: 'bash' }, NEVER)
    await waitFor(() => h.sent().some((body) => Array.isArray(body.blocks)))
    h.push(messageEvent('C42', 'are you there?', { ts: '1700000007.001' }))
    const ack = await waitFor(() => h.sent().find((body) => typeof body.text === 'string' && body.text.includes('Queued')))
    assert(ack.text.includes('Answer the prompt above'), 'the ack names the prompt: ' + ack.text)
    h.push(messageEvent('C42', '!deny', { ts: '1700000008.001' }))
    equal(await outcome, 'rejected', 'the prompt still settles')
    await h.dispose()
  } finally {
    await mock.close()
  }
})

test('the prompt is escaped like a reply, not rendered as markdown', async () => {
  const mock = await startMockSlack()
  try {
    const h = await mount(mock)
    const agent = await startSession(h)
    const outcome = h.waterfall('approval/request', { agent, toolName: 'bash', reason: '<https://evil|click> @channel' }, NEVER)
    const prompt = await waitFor(() => h.sent().find((body) => Array.isArray(body.blocks)))
    assert(prompt.blocks[0].text.text.includes('&lt;https://evil|click&gt;'), 'the reason is escaped: ' + prompt.blocks[0].text.text)
    h.push(messageEvent('C42', '!deny', { ts: '1700000006.001' }))
    equal(await outcome, 'rejected')
    await sleep(20)
    await h.dispose()
  } finally {
    await mock.close()
  }
})
