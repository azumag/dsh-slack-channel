// Interaction-manager tests: the Slack side of the approval and
// ask_user_question seams — prompts, buttons, text fallbacks, delegation,
// and every way a prompt settles (answer, downstream, deadline, abort).

import { test, assert, equal, sleep, waitFor } from './_util.mjs'
import {
  ACTION_APPROVAL_ALLOW,
  ACTION_APPROVAL_DENY,
  ACTION_QUESTION_OPTION,
  ACTION_QUESTION_SUBMIT,
  createInteractions,
} from '../src/interactions.js'

const NEVER = () => new Promise(() => {})

/** A manager wired to recording fakes. */
function mount({ interactiveTimeoutMs = 5000, threadReplies = true, authorized = () => true, postDelayMs = 0 } = {}) {
  const calls = []
  const records = new Map()
  const logs = []
  const slack = {
    async postMessage(channel, text, options = {}) {
      if (postDelayMs > 0) await sleep(postDelayMs)
      calls.push({ method: 'chat.postMessage', channel, text, options })
      return { channel, ts: 'ts-' + calls.length }
    },
    async updateMessage(channel, ts, text, options = {}) {
      calls.push({ method: 'chat.update', channel, ts, text, options })
      return { channel, ts }
    },
  }
  const interactions = createInteractions({
    config: { interactiveTimeoutMs, threadReplies },
    logger: { info: () => {}, warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    slack,
    sessions: { lookup: (id) => records.get(id) },
    authorized,
    mrkdwnOptions: {},
  })
  return {
    interactions,
    records,
    calls,
    logs,
    posts: () => calls.filter((call) => call.method === 'chat.postMessage'),
    updates: () => calls.filter((call) => call.method === 'chat.update'),
  }
}

/** One owned channel session record, as sessions.js builds it. */
function owned(channel = 'C42', sessionId = 'S1', threadTs = 'ts-root') {
  const agent = { session: { id: sessionId } }
  return { agent, record: { chatId: channel, agent, threadTs, busy: true } }
}

/** One Block Kit click as Slack delivers it to the socket loop. */
function click(channel, actionId, value, userId = 'U-ACTOR') {
  return { type: 'block_actions', channel: { id: channel }, user: { id: userId }, actions: [{ action_id: actionId, value }] }
}

/** The buttons of one actions block, keyed by action id. */
function button(blocks, actionId) {
  for (const block of blocks) {
    for (const element of block.elements ?? []) {
      if (element.action_id === actionId) return element
    }
  }
  return undefined
}

function hasActions(blocks) {
  return blocks.some((block) => block.type === 'actions')
}

test('approval: posts a threaded prompt and the Allow button decides it', async () => {
  const h = mount()
  const { agent, record } = owned()
  h.records.set(agent.session.id, record)
  const pending = h.interactions.answerApproval({ agent, toolName: 'bash', reason: 'needs network' }, NEVER)
  await waitFor(() => h.posts().length === 1)
  const post = h.posts()[0]
  equal(post.channel, 'C42', 'prompt lands in the channel')
  equal(post.options.threadTs, 'ts-root', 'prompt lands in the turn thread')
  assert(post.text.includes('bash'), 'fallback text names the tool')
  assert(post.options.blocks[0].text.text.includes('needs network'), 'prompt shows the reason')
  const allow = button(post.options.blocks, ACTION_APPROVAL_ALLOW)
  const deny = button(post.options.blocks, ACTION_APPROVAL_DENY)
  assert(allow !== undefined && deny !== undefined, 'both buttons are present')

  const interact = h.interactions.handleInteractive(click('C42', ACTION_APPROVAL_ALLOW, allow.value))
  equal(await pending, 'allowed-once', 'the click decides the approval')
  await interact
  await waitFor(() => h.updates().length === 1)
  assert(hasActions(h.updates()[0].options.blocks) === false, 'buttons are retired after the decision')
  assert(h.updates()[0].options.blocks[0].text.text.includes('Allowed once'), 'the message shows the decision')
  assert(h.updates()[0].options.blocks[0].text.text.includes('<@U-ACTOR>'), 'the message names the actor')
})

test('approval: the Deny button rejects', async () => {
  const h = mount()
  const { agent, record } = owned()
  h.records.set(agent.session.id, record)
  const pending = h.interactions.answerApproval({ agent, toolName: 'bash' }, NEVER)
  await waitFor(() => h.posts().length === 1)
  const deny = button(h.posts()[0].options.blocks, ACTION_APPROVAL_DENY)
  await h.interactions.handleInteractive(click('C42', ACTION_APPROVAL_DENY, deny.value))
  equal(await pending, 'rejected', 'deny rejects the request')
  await waitFor(() => h.updates().length === 1 && h.updates()[0].options.blocks[0].text.text.includes('Denied'))
})

test('approval: !allow and !deny answer without a click', async () => {
  const h = mount()
  const { agent, record } = owned()
  h.records.set(agent.session.id, record)
  const pending = h.interactions.answerApproval({ agent, toolName: 'bash' }, NEVER)
  await waitFor(() => h.posts().length === 1)
  equal(h.interactions.answerFromText('C42', 'allow', '', 'U-TEXT'), true, 'the command is consumed')
  equal(await pending, 'allowed-once', 'the command decides the approval')
  await waitFor(() => h.updates().length === 1)
  assert(h.updates()[0].options.blocks[0].text.text.includes('<@U-TEXT>'), 'the actor is mentioned')
})

test('approval: a deadline fails closed and retires the prompt', async () => {
  const h = mount({ interactiveTimeoutMs: 40 })
  const { agent, record } = owned()
  h.records.set(agent.session.id, record)
  const outcome = await h.interactions.answerApproval({ agent, toolName: 'bash' }, NEVER)
  equal(outcome, 'unavailable', 'an unanswered approval fails closed')
  await waitFor(() => h.updates().length === 1)
  assert(h.updates()[0].options.blocks[0].text.text.includes('Expired'), 'the message reports the expiry')
  assert(hasActions(h.updates()[0].options.blocks) === false, 'the buttons are gone')
})

test('approval: aborting the request cancels the prompt', async () => {
  const h = mount()
  const { agent, record } = owned()
  h.records.set(agent.session.id, record)
  const controller = new AbortController()
  const pending = h.interactions.answerApproval({ agent, toolName: 'bash', signal: controller.signal }, NEVER)
  await waitFor(() => h.posts().length === 1)
  controller.abort()
  equal(await pending, 'cancelled', 'an aborted request settles cancelled')
  await waitFor(() => h.updates().length === 1 && h.updates()[0].options.blocks[0].text.text.includes('Cancelled'))
})

test('approval: a foreign agent is delegated untouched', async () => {
  const h = mount()
  let delegated = 0
  const outcome = await h.interactions.answerApproval(
    { agent: { session: { id: 'other' } }, toolName: 'bash' },
    () => { delegated += 1; return Promise.resolve('rejected') },
  )
  equal(outcome, 'rejected', 'the downstream answer is returned')
  equal(delegated, 1, 'next() was called')
  equal(h.posts().length, 0, 'no Slack prompt for a foreign agent')
})

test('approval: a subagent of an owned session is prompted in the channel', async () => {
  const h = mount()
  const { agent, record } = owned()
  h.records.set(agent.session.id, record)
  const child = { session: { id: 'child' }, parentAgent: agent }
  const pending = h.interactions.answerApproval({ agent: child, toolName: 'bash' }, NEVER)
  await waitFor(() => h.posts().length === 1)
  equal(h.interactions.answerFromText('C42', 'allow', '', 'U1'), true, 'the channel answers for the child')
  equal(await pending, 'allowed-once', 'the child request settles with the root channel')
})

test('approval: a decisive downstream answerer wins and retires the prompt', async () => {
  const h = mount()
  const { agent, record } = owned()
  h.records.set(agent.session.id, record)
  const outcome = await h.interactions.answerApproval({ agent, toolName: 'bash' }, () => Promise.resolve('rejected'))
  equal(outcome, 'rejected', 'the UI decision is honored')
  await waitFor(() => h.updates().length === 1)
  assert(h.updates()[0].options.blocks[0].text.text.includes('Denied'), 'the prompt reports the UI decision')
  assert(h.updates()[0].options.blocks[0].text.text.includes('DSH UI'), 'and says where it was answered')
})

test('approval: a downstream "unavailable" does not cut the Slack wait short', async () => {
  const h = mount()
  const { agent, record } = owned()
  h.records.set(agent.session.id, record)
  const pending = h.interactions.answerApproval({ agent, toolName: 'bash' }, () => Promise.resolve('unavailable'))
  await waitFor(() => h.posts().length === 1)
  await sleep(60) // the fail-closed downstream must NOT settle the prompt
  assert(h.updates().length === 0, 'the prompt is still open')
  const allow = button(h.posts()[0].options.blocks, ACTION_APPROVAL_ALLOW)
  await h.interactions.handleInteractive(click('C42', ACTION_APPROVAL_ALLOW, allow.value))
  equal(await pending, 'allowed-once', 'the late Slack answer still decides')
})

test('approval: a failed post fails closed instead of holding the turn', async () => {
  const h = mount()
  const { agent, record } = owned()
  h.records.set(agent.session.id, record)
  h.interactions = createInteractions({
    config: { interactiveTimeoutMs: 60000, threadReplies: true },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    slack: { postMessage: async () => { throw new Error('slack down') }, updateMessage: async () => ({}) },
    sessions: { lookup: () => record },
    authorized: () => true,
    mrkdwnOptions: {},
  })
  const outcome = await h.interactions.answerApproval({ agent, toolName: 'bash' }, NEVER)
  equal(outcome, 'unavailable', 'no prompt on Slack means no approval')
})

test('approval: clicks from an unauthorized channel are ignored', async () => {
  const h = mount({ authorized: (channel) => channel === 'C-OK' })
  const { agent, record } = owned('C-OK')
  h.records.set(agent.session.id, record)
  const pending = h.interactions.answerApproval({ agent, toolName: 'bash' }, NEVER)
  await waitFor(() => h.posts().length === 1)
  const allow = button(h.posts()[0].options.blocks, ACTION_APPROVAL_ALLOW)
  await h.interactions.handleInteractive(click('C-OTHER', ACTION_APPROVAL_ALLOW, allow.value))
  await sleep(60)
  assert(h.updates().length === 0, 'the click changed nothing')
  await h.interactions.handleInteractive(click('C-OK', ACTION_APPROVAL_ALLOW, allow.value))
  equal(await pending, 'allowed-once', 'an authorized click still works')
})

test('question: option buttons answer the batch', async () => {
  const h = mount()
  const { agent, record } = owned()
  h.records.set(agent.session.id, record)
  const request = {
    agent,
    questions: [
      { id: 'a', header: 'Confirm', question: 'Deploy?', options: [{ label: 'Yes' }, { label: 'No' }] },
      { id: 'b', question: 'Which region?', options: [{ label: 'ap-northeast-1' }] },
    ],
  }
  const pending = h.interactions.answerQuestion(request, NEVER)
  await waitFor(() => h.posts().length === 1)
  const blocks = h.posts()[0].options.blocks
  const options = blocks.flatMap((block) => block.elements ?? []).filter((element) => element.action_id === ACTION_QUESTION_OPTION)
  equal(options.length, 3, 'one button per option')
  assert(blocks[0].text.text.includes('2 question'), 'the prompt counts the questions')

  await h.interactions.handleInteractive(click('C42', ACTION_QUESTION_OPTION, options[0].value))
  await sleep(40)
  assert(h.updates().length >= 1, 'a partial answer re-renders the prompt')
  await h.interactions.handleInteractive(click('C42', ACTION_QUESTION_OPTION, options[2].value))
  const answer = await pending
  equal(answer.answers, [
    { id: 'a', selected: ['Yes'] },
    { id: 'b', selected: ['ap-northeast-1'] },
  ], 'the batch carries every answer')
  await waitFor(() => h.updates().some((call) => call.options.blocks[0].text.text.includes('Answered')))
})

test('question: a multi-select question toggles and commits on Submit', async () => {
  const h = mount()
  const { agent, record } = owned()
  h.records.set(agent.session.id, record)
  const request = { agent, questions: [{ id: 'a', question: 'Pick some', multiSelect: true, options: [{ label: 'one' }, { label: 'two' }] }] }
  const pending = h.interactions.answerQuestion(request, NEVER)
  await waitFor(() => h.posts().length === 1)
  const buttons = h.posts()[0].options.blocks.flatMap((block) => block.elements ?? [])
  await h.interactions.handleInteractive(click('C42', ACTION_QUESTION_OPTION, buttons[0].value))
  await h.interactions.handleInteractive(click('C42', ACTION_QUESTION_OPTION, buttons[1].value))
  await waitFor(() => h.updates().length >= 1)
  const afterToggle = h.updates()[h.updates().length - 1].options.blocks.flatMap((block) => block.elements ?? [])
  const submit = afterToggle.find((element) => element.action_id === ACTION_QUESTION_SUBMIT)
  assert(submit !== undefined, 'Submit appears once something is selected')
  // Toggling one back off removes it again.
  await h.interactions.handleInteractive(click('C42', ACTION_QUESTION_OPTION, buttons[0].value))
  await h.interactions.handleInteractive(click('C42', ACTION_QUESTION_SUBMIT, submit.value))
  const answer = await pending
  equal(answer.answers, [{ id: 'a', selected: ['two'] }], 'Submit commits the remaining selection')
})

test('question: !answer supplies free text; a bare message only answers an option-less question', async () => {
  const h = mount()
  const { agent, record } = owned()
  h.records.set(agent.session.id, record)
  const withOptions = h.interactions.answerQuestion({
    agent,
    questions: [{ id: 'a', question: 'Deploy?', options: [{ label: 'Yes' }, { label: 'No' }] }],
  }, NEVER)
  await waitFor(() => h.posts().length === 1)
  equal(h.interactions.answerFromText('C42', undefined, 'a stray message', 'U1'), false, 'a bare message never answers a buttoned question')
  equal(h.interactions.answerFromText('C42', 'answer', 'ship it after lunch', 'U1'), true, 'the explicit form is the Other answer')
  equal((await withOptions).answers, [{ id: 'a', selected: [], custom: 'ship it after lunch' }], 'the free text carries as custom')

  const freeForm = h.interactions.answerQuestion({ agent, questions: [{ id: 'b', question: 'Which branch?' }] }, NEVER)
  await waitFor(() => h.posts().length === 2)
  equal(h.interactions.answerFromText('C42', undefined, 'feature/x', 'U1'), true, 'a bare message answers an option-less question')
  equal((await freeForm).answers, [{ id: 'b', selected: [], custom: 'feature/x' }], 'the bare text carries as custom')
})

test('question: a deadline reports the timeout to the model', async () => {
  const h = mount({ interactiveTimeoutMs: 40 })
  const { agent, record } = owned()
  h.records.set(agent.session.id, record)
  let error
  try {
    await h.interactions.answerQuestion({ agent, questions: [{ id: 'a', question: 'Deploy?' }] }, NEVER)
  } catch (caught) {
    error = caught
  }
  assert(error !== undefined, 'an unanswered question throws')
  assert(error.message.includes('no answer within'), 'the error names the timeout: ' + error.message)
  await waitFor(() => h.updates().length === 1 && h.updates()[0].options.blocks[0].text.text.includes('Expired'))
})

test('question: aborting the turn cancels the prompt', async () => {
  const h = mount()
  const { agent, record } = owned()
  h.records.set(agent.session.id, record)
  const controller = new AbortController()
  const pending = h.interactions.answerQuestion({ agent, questions: [{ id: 'a', question: 'Deploy?' }], signal: controller.signal }, NEVER)
  await waitFor(() => h.posts().length === 1)
  controller.abort()
  let error
  try {
    await pending
  } catch (caught) {
    error = caught
  }
  assert(error !== undefined && error.message.includes('cancelled'), 'an aborted question throws')
  await waitFor(() => h.updates().length === 1 && h.updates()[0].options.blocks[0].text.text.includes('Cancelled'))
})

test('question: a downstream answerer that answers wins; NO_PROVIDER does not', async () => {
  const h = mount()
  const { agent, record } = owned()
  h.records.set(agent.session.id, record)
  const answered = await h.interactions.answerQuestion(
    { agent, questions: [{ id: 'a', question: 'Deploy?' }] },
    () => Promise.resolve({ answers: [{ id: 'a', selected: ['Yes'] }] }),
  )
  equal(answered.answers, [{ id: 'a', selected: ['Yes'] }], 'the UI answer is returned')

  const noProvider = new Error('no user-questions answerer accepted the request')
  noProvider.code = 'NO_PROVIDER'
  const pending = h.interactions.answerQuestion(
    { agent, questions: [{ id: 'b', question: 'Which branch?' }] },
    () => Promise.reject(noProvider),
  )
  await waitFor(() => h.posts().length === 2)
  await sleep(40)
  assert(h.updates().length === 1, 'the first prompt settled; the second is still open')
  equal(h.interactions.answerFromText('C42', undefined, 'main', 'U1'), true, 'the Slack answer still lands')
  equal((await pending).answers, [{ id: 'b', selected: [], custom: 'main' }], 'NO_PROVIDER left the channel in charge')
})

test('question: a foreign agent is delegated untouched', async () => {
  const h = mount()
  const answer = { answers: [{ id: 'a', selected: ['Yes'] }] }
  const result = await h.interactions.answerQuestion({ agent: { session: { id: 'other' } }, questions: [{ id: 'a' }] }, () => Promise.resolve(answer))
  equal(result, answer, 'the downstream answer is returned as-is')
  equal(h.posts().length, 0, 'no Slack prompt for a foreign agent')
})

test('a decision that races the post still retires the buttons', async () => {
  const h = mount({ postDelayMs: 40 })
  const { agent, record } = owned()
  h.records.set(agent.session.id, record)
  const pending = h.interactions.answerApproval({ agent, toolName: 'bash' }, NEVER)
  await waitFor(() => h.interactions.hasPending('C42'))
  equal(h.interactions.answerFromText('C42', 'deny', '', 'U1'), true, 'the command lands before the post returns')
  equal(await pending, 'rejected', 'the decision is not lost to the race')
  await waitFor(() => h.updates().length === 1)
  assert(h.updates()[0].options.blocks[0].text.text.includes('Denied'), 'the posted message is still updated')
})

test('an already-aborted request never posts a prompt', async () => {
  const h = mount()
  const { agent, record } = owned()
  h.records.set(agent.session.id, record)
  const controller = new AbortController()
  controller.abort()
  equal(await h.interactions.answerApproval({ agent, toolName: 'bash', signal: controller.signal }, NEVER), 'cancelled', 'the approval is cancelled')
  let error
  try {
    await h.interactions.answerQuestion({ agent, questions: [{ id: 'a', question: 'Deploy?' }], signal: controller.signal }, NEVER)
  } catch (caught) {
    error = caught
  }
  assert(error !== undefined && error.message.includes('cancelled'), 'the question rejects too')
  equal(h.posts().length, 0, 'nothing was posted')
})

test('teardown settles every pending prompt', async () => {
  const h = mount({ interactiveTimeoutMs: 0 })
  const { agent, record } = owned()
  h.records.set(agent.session.id, record)
  const approval = h.interactions.answerApproval({ agent, toolName: 'bash' }, NEVER)
  const question = h.interactions.answerQuestion({ agent, questions: [{ id: 'a', question: 'Deploy?' }] }, NEVER)
  await waitFor(() => h.posts().length === 2)
  assert(h.interactions.hasPending('C42'), 'both prompts are tracked')
  h.interactions.disposeAll()
  equal(await approval, 'cancelled', 'a pending approval settles cancelled')
  let error
  try {
    await question
  } catch (caught) {
    error = caught
  }
  assert(error !== undefined, 'a pending question settles too')
  equal(h.interactions.hasPending('C42'), false, 'nothing stays pending')
  equal(h.updates().length, 0, 'teardown writes nothing to Slack')
})

test('an indefinite prompt keeps waiting until it is answered', async () => {
  const h = mount({ interactiveTimeoutMs: 0 })
  const { agent, record } = owned()
  h.records.set(agent.session.id, record)
  const pending = h.interactions.answerApproval({ agent, toolName: 'bash' }, NEVER)
  await waitFor(() => h.posts().length === 1)
  await sleep(60)
  assert(h.updates().length === 0, 'interactiveTimeoutMs: 0 never expires the prompt')
  assert(h.posts()[0].options.blocks[0].text.text.includes('until the turn is stopped'), 'the prompt says so')
  equal(h.interactions.answerFromText('C42', 'deny', '', 'U1'), true, 'the text command still decides it')
  equal(await pending, 'rejected')
})

test('a click on a settled prompt changes nothing', async () => {
  const h = mount()
  const { agent, record } = owned()
  h.records.set(agent.session.id, record)
  const pending = h.interactions.answerApproval({ agent, toolName: 'bash' }, NEVER)
  await waitFor(() => h.posts().length === 1)
  const allow = button(h.posts()[0].options.blocks, ACTION_APPROVAL_ALLOW)
  await h.interactions.handleInteractive(click('C42', ACTION_APPROVAL_ALLOW, allow.value))
  equal(await pending, 'allowed-once')
  await waitFor(() => h.updates().length === 1)
  await h.interactions.handleInteractive(click('C42', ACTION_APPROVAL_DENY, allow.value))
  await sleep(40)
  equal(h.updates().length, 1, 'the late click is ignored')
})
