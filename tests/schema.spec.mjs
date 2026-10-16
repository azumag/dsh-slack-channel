// Config schema validation tests — no host, no network.

import { test, assert, equal } from './_util.mjs'
import { Config } from '../src/schema.js'

function validate(input) {
  return Config['~standard'].validate(input)
}

test('defaults apply to an empty config', () => {
  const { value, issues } = validate({})
  assert(issues === undefined, 'no issues expected')
  equal(value.apiBase, 'https://slack.com/api')
  equal(value.allowedChannelIds, [])
  equal(value.allowAllChannels, false)
  equal(value.retryDelayMs, 3000)
  equal(value.socketRetryDelayMs, 2000)
  equal(value.maxReplyChars, 4000)
  equal(value.replyMode, 'last')
  equal(value.threadReplies, true)
  equal(value.ackReaction, 'hourglass')
  equal(value.notifyUnauthorized, false)
  equal(value.mentionOnly, false)
  equal(value.mentionUserIds, [])
  equal(value.contextMessages, 20)
  equal(value.botToken, undefined)
  equal(value.appToken, undefined)
})

test('mentionOnly and contextMessages accept values within bounds', () => {
  const ok = validate({ mentionOnly: true, contextMessages: 0 })
  assert(ok.issues === undefined, 'contextMessages 0 disables the buffer')
  equal(ok.value.mentionOnly, true)
  equal(ok.value.contextMessages, 0)

  const tooBig = validate({ contextMessages: 201 })
  assert(tooBig.issues !== undefined, 'contextMessages above the cap is rejected')
  const negative = validate({ contextMessages: -1 })
  assert(negative.issues !== undefined, 'a negative contextMessages is rejected')
})

test('mentionUserIds validates, de-duplicates and defaults to empty', () => {
  const none = validate({})
  equal(none.value.mentionUserIds, [])

  const ok = validate({ mentionUserIds: ['U0C7AN52QGN', 'U0C6HEG8KC6', 'U0C7AN52QGN'] })
  assert(ok.issues === undefined, 'real-looking ids pass: ' + JSON.stringify(ok.issues))
  equal(ok.value.mentionUserIds, ['U0C7AN52QGN', 'U0C6HEG8KC6'], 'duplicates collapse, order kept')

  const notArray = validate({ mentionUserIds: 'U0C7AN52QGN' })
  assert(notArray.issues !== undefined, 'a bare string is rejected')

  // The schema reports issues INSTEAD of a value, so a bad entry surfaces
  // rather than being silently dropped.
  const bad = validate({ mentionUserIds: ['U0C7AN52QGN', '<@U0C6HEG8KC6>', 42, ''] })
  assert(bad.issues !== undefined, 'bad entries are reported')
  equal(bad.value, undefined, 'no value is handed out while issues stand')
})

test('valid values pass through', () => {
  const { value, issues } = validate({
    botToken: 'xoxb-test',
    appToken: 'xapp-test',
    apiBase: 'http://127.0.0.1:8081',
    provider: 'deepseek-official',
    model: 'deepseek-chat',
    cwd: '/tmp/work',
    allowedChannelIds: ['C123', 'G456', 'D789'],
    allowAllChannels: true,
    retryDelayMs: 0,
    socketRetryDelayMs: 10,
    maxReplyChars: 20000,
    replyMode: 'all',
    threadReplies: false,
    ackReaction: 'eyes',
    notifyUnauthorized: true,
    stateFile: '/tmp/state.json',
    pairToken: 'topsecret',
  })
  assert(issues === undefined, 'no issues expected, got ' + JSON.stringify(issues))
  equal(value.botToken, 'xoxb-test')
  equal(value.appToken, 'xapp-test')
  equal(value.allowedChannelIds, ['C123', 'G456', 'D789'])
  equal(value.replyMode, 'all')
  equal(value.ackReaction, 'eyes')
  equal(value.pairToken, 'topsecret')
})

test('agentPreset accepts a name and rejects an empty one', () => {
  const ok = validate({ agentPreset: 'standard' })
  assert(ok.issues === undefined, 'no issues expected')
  equal(ok.value.agentPreset, 'standard')

  const blank = validate({ agentPreset: '   ' })
  assert(blank.issues !== undefined && blank.issues.some((i) => i.message.includes('agentPreset')), 'agentPreset issue expected')
})

test('non-object config is rejected', () => {
  const { issues } = validate([1, 2])
  assert(issues !== undefined && issues.length > 0, 'issues expected')
})

test('relative cwd is rejected', () => {
  const { issues } = validate({ cwd: 'relative/path' })
  assert(issues !== undefined && issues.some((i) => i.message.includes('absolute')), 'absolute cwd expected')
})

test('bad apiBase is rejected', () => {
  const { issues } = validate({ apiBase: 'ftp://example.com' })
  assert(issues !== undefined && issues.some((i) => i.message.includes('apiBase')), 'apiBase issue expected')
})

test('maxReplyChars above 40000 is rejected', () => {
  const { issues } = validate({ maxReplyChars: 50000 })
  assert(issues !== undefined && issues.some((i) => i.message.includes('maxReplyChars')), 'maxReplyChars issue expected')
})

test('unknown replyMode is rejected', () => {
  const { issues } = validate({ replyMode: 'thread' })
  assert(issues !== undefined && issues.some((i) => i.message.includes('replyMode')), 'replyMode issue expected')
})

test('non-string allowedChannelIds are rejected', () => {
  const { issues } = validate({ allowedChannelIds: [42] })
  assert(issues !== undefined && issues.length > 0, 'issues expected')
})

test('pairToken requires stateFile', () => {
  const { issues } = validate({ pairToken: 'topsecret' })
  assert(issues !== undefined && issues.some((i) => i.message.includes('pairToken')), 'pairToken issue expected')
})

test('pairToken with stateFile validates', () => {
  const { issues } = validate({ pairToken: 'topsecret', stateFile: '/tmp/state.json' })
  assert(issues === undefined, 'no issues expected, got ' + JSON.stringify(issues))
})

test('empty-string fields are rejected', () => {
  const { issues } = validate({ botToken: '   ' })
  assert(issues !== undefined && issues.some((i) => i.message.includes('botToken')), 'botToken issue expected')
})
