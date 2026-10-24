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
  equal(value.mentionBackBots, false)
  equal(value.maxBotTurns, 10)
  equal(value.maxBotRepeats, 3)
  equal(value.mentionUserIds, [])
  equal(value.contextMessages, 20)
  equal(value.interactiveTimeoutMs, 1800000)
  equal(value.botToken, undefined)
  equal(value.appToken, undefined)
})

test('interactiveTimeoutMs takes a deadline, 0, and rejects nonsense', () => {
  const ok = validate({ interactiveTimeoutMs: 60000 })
  assert(ok.issues === undefined, 'a positive deadline passes')
  equal(ok.value.interactiveTimeoutMs, 60000)

  const forever = validate({ interactiveTimeoutMs: 0 })
  assert(forever.issues === undefined, '0 means "wait until the turn is stopped"')
  equal(forever.value.interactiveTimeoutMs, 0)

  const negative = validate({ interactiveTimeoutMs: -1 })
  assert(negative.issues !== undefined, 'a negative deadline is rejected')

  const tooBig = validate({ interactiveTimeoutMs: 25 * 60 * 60 * 1000 })
  assert(tooBig.issues !== undefined, 'a deadline beyond the 24h cap is rejected')
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

test('maxBotTurns and maxBotRepeats take 0..n and reject fractions and strings', () => {
  equal(validate({}).value.maxBotTurns, 10)
  equal(validate({ maxBotTurns: 0 }).value.maxBotTurns, 0)
  equal(validate({ maxBotTurns: 25 }).value.maxBotTurns, 25)
  assert(validate({ maxBotTurns: -1 }).issues !== undefined, 'negative is rejected')
  assert(validate({ maxBotTurns: 1.5 }).issues !== undefined, 'fraction is rejected')
  assert(validate({ maxBotTurns: '2' }).issues !== undefined, 'string is rejected')
  equal(validate({}).value.maxBotRepeats, 3)
  equal(validate({ maxBotRepeats: 0 }).value.maxBotRepeats, 0)
  assert(validate({ maxBotRepeats: -1 }).issues !== undefined, 'negative repeat limit is rejected')
  assert(validate({ maxBotRepeats: 2.5 }).issues !== undefined, 'fractional repeat limit is rejected')
  equal(validate({ mentionBackBots: true }).value.mentionBackBots, true)
  equal(validate({}).value.mentionBackBotIds, [])
  equal(validate({ mentionBackBotIds: ['U0CCCH69XMW', 'U0CCCH69XMW'] }).value.mentionBackBotIds, ['U0CCCH69XMW'])
  assert(validate({ mentionBackBotIds: ['<@U0CCCH69XMW>'] }).issues !== undefined, 'a non-id entry is rejected')
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

test('ccUserIds validates, de-duplicates and defaults to empty', () => {
  equal(validate({}).value.ccUserIds, [])
  const ok = validate({ ccUserIds: ['U0C6HEG8KC6', 'U0C6HEG8KC6'] })
  assert(ok.issues === undefined, 'real-looking ids pass: ' + JSON.stringify(ok.issues))
  equal(ok.value.ccUserIds, ['U0C6HEG8KC6'], 'duplicates collapse, order kept')
  const bad = validate({ ccUserIds: ['<@U0C6HEG8KC6>'] })
  assert(bad.issues !== undefined, 'a decorated id is rejected')
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

test('fallback route requires both provider and model', () => {
  const ok = validate({ fallbackProvider: 'opencode-go', fallbackModel: 'deepseek-v4.1-flash' })
  assert(ok.issues === undefined, 'no issues expected, got ' + JSON.stringify(ok.issues))
  equal(ok.value.fallbackProvider, 'opencode-go')
  equal(ok.value.fallbackModel, 'deepseek-v4.1-flash')

  const partial = validate({ fallbackProvider: 'opencode-go' })
  assert(partial.issues !== undefined && partial.issues.some((i) => i.message.includes('set together')), 'pair issue expected')

  const blank = validate({ fallbackProvider: ' ', fallbackModel: 'deepseek-v4.1-flash' })
  assert(blank.issues !== undefined && blank.issues.some((i) => i.message.includes('fallbackProvider')), 'fallbackProvider issue expected')
})

test('the single-route fallback fields become a one-entry chain', () => {
  const ok = validate({ fallbackProvider: 'opencode-go', fallbackModel: 'deepseek-v4.1-flash', fallbackReasoningEffort: 'high' })
  assert(ok.issues === undefined, 'no issues expected, got ' + JSON.stringify(ok.issues))
  equal(ok.value.fallbacks, [{ provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' }])
  equal(ok.value.fallbackOn, 'any')
  equal(validate({}).value.fallbacks, [])
})

test('fallbacks lists routes in order', () => {
  const ok = validate({
    fallbacks: [
      { provider: 'nvidia', model: 'moonshotai/kimi-k2.6' },
      { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
    ],
    fallbackOn: 'quota',
  })
  assert(ok.issues === undefined, 'no issues expected, got ' + JSON.stringify(ok.issues))
  equal(ok.value.fallbacks, [
    { provider: 'nvidia', model: 'moonshotai/kimi-k2.6' },
    { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
  ])
  equal(ok.value.fallbackOn, 'quota')
})

test('fallbacks rejects malformed entries, mixing with the single-route form, and unknown triggers', () => {
  const notArray = validate({ fallbacks: { provider: 'nvidia', model: 'z-ai/glm-5.3' } })
  assert(notArray.issues?.some((i) => i.message.includes('fallbacks must be an array')), 'array issue expected')

  const missing = validate({ fallbacks: [{ provider: 'nvidia' }, 'nvidia/z-ai/glm-5.3'] })
  assert(missing.issues?.some((i) => i.message.includes('fallbacks[0].model')), 'model issue expected')
  assert(missing.issues?.some((i) => i.message.includes('fallbacks[1] must be an object')), 'object issue expected')

  const both = validate({
    fallbacks: [{ provider: 'nvidia', model: 'z-ai/glm-5.3' }],
    fallbackProvider: 'opencode-go',
    fallbackModel: 'deepseek-v4.1-flash',
  })
  assert(both.issues?.some((i) => i.message.includes('not both')), 'mixing issue expected')

  const trigger = validate({ fallbackOn: 'sometimes' })
  assert(trigger.issues?.some((i) => i.message.includes('fallbackOn')), 'trigger issue expected')
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

test('mentionRewrites validates id → id pairs and defaults to empty', () => {
  equal(validate({}).value.mentionRewrites, {})
  const ok = validate({ mentionRewrites: { U0C6HEG8KC6: 'U0CCCH69XMW' } })
  assert(ok.issues === undefined, 'real-looking ids pass: ' + JSON.stringify(ok.issues))
  equal(ok.value.mentionRewrites, { U0C6HEG8KC6: 'U0CCCH69XMW' })
  assert(validate({ mentionRewrites: ['U0C6HEG8KC6'] }).issues !== undefined, 'a list is rejected')
  assert(validate({ mentionRewrites: { U0C6HEG8KC6: '<@U0CCCH69XMW>' } }).issues !== undefined, 'a non-id target is rejected')
})

test('slackSurface defaults on and surfacePrompt is an optional string', () => {
  equal([validate({}).value.slackSurface, validate({}).value.surfacePrompt], [true, undefined])
  equal(validate({ slackSurface: false }).value.slackSurface, false)
  equal(validate({ surfacePrompt: 'Team: Hermes <@U0C7AN52QGN>.' }).value.surfacePrompt, 'Team: Hermes <@U0C7AN52QGN>.')
  assert(validate({ surfacePrompt: '  ' }).issues !== undefined, 'a blank prompt is rejected')
})

test('fallbackCooldownMs defaults to 0 and takes non-negative milliseconds', () => {
  equal(validate({}).value.fallbackCooldownMs, 0)
  equal(validate({ fallbackCooldownMs: 120000 }).value.fallbackCooldownMs, 120000)
  assert(validate({ fallbackCooldownMs: -1 }).issues !== undefined, 'negative is rejected')
  assert(validate({ fallbackCooldownMs: '2m' }).issues !== undefined, 'a string is rejected')
})
