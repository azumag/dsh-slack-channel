// Chat-session manager tests with a fake agents registry.

import { test, assert, equal, sleep } from './_util.mjs'
import { createChatSessions } from '../src/sessions.js'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function makeLogger() {
  const lines = []
  return {
    lines,
    info: (...a) => lines.push('info ' + a.join(' ')),
    warn: (...a) => lines.push('warn ' + a.join(' ')),
    error: (...a) => lines.push('error ' + a.join(' ')),
  }
}

function makeAgents({ resumeFails = false, resumeError, live = new Map() } = {}) {
  const created = []
  const resumed = []
  const disposed = []
  const setups = []
  let counter = 0
  return {
    created, resumed, disposed, setups, live,
    /** The registry's live-agent lookup: agents some other owner holds. */
    get(id) {
      return live.get(id)
    },
    async create(options) {
      const id = options.sessionId ?? ('gen-' + (++counter))
      if (options.setup !== undefined) {
        const agentCtx = makeAgentCtx(id)
        setups.push({ id, ctx: agentCtx })
        await options.setup(agentCtx, { id, session: { id } })
      }
      const agent = { id, session: { id, header: { id } }, options }
      created.push(agent)
      return { agent, dispose: async () => { disposed.push(id) } }
    },
    async resume(options) {
      if (resumeFails) throw new Error('persistence not configured')
      if (resumeError !== undefined) throw resumeError(options)
      const id = options.resumeSessionId
      if (options.setup !== undefined) {
        const agentCtx = makeAgentCtx(id)
        setups.push({ id, ctx: agentCtx })
        await options.setup(agentCtx, { id, session: { id } })
      }
      const agent = { id, session: { id, header: { id } }, options }
      resumed.push(agent)
      return { agent, dispose: async () => { disposed.push(id) } }
    },
  }
}

/** Minimal agent-scoped context: records event listeners like cordis does. */
function makeAgentCtx(id) {
  const listeners = {}
  return {
    scope: 'agent:' + id,
    listeners,
    on(event, fn) {
      ;(listeners[event] ??= []).push(fn)
      return () => {
        const at = listeners[event].indexOf(fn)
        if (at >= 0) listeners[event].splice(at, 1)
      }
    },
  }
}

/**
 * Invoke the first listener registered for `event`. The real dispatcher is a
 * waterfall, but each fallback listener is independent; calling it directly
 * with an explicit `next` keeps the assertions about delegation exact.
 */
async function callListener(agentCtx, event, ...args) {
  const listener = (agentCtx.listeners[event] ?? [])[0]
  assert(listener !== undefined, 'no listener registered for ' + event)
  return listener(...args)
}

/** Fake agentPresets service: records mounts, optionally fails resolve. */
function makePresets({ failResolve = false } = {}) {
  const mounts = []
  return {
    mounts,
    async resolve(id) {
      if (failResolve) throw new Error('unknown preset ' + id)
      return { id }
    },
    async mount(agentCtx, id) {
      mounts.push({ agentCtx, id })
    },
  }
}

test('creates a fresh session per chat', async () => {
  const agents = makeAgents()
  const logger = makeLogger()
  const sessions = createChatSessions({ ctx: { agents, get: () => undefined }, config: { cwd: '/tmp' }, logger })
  const record = await sessions.get(42)
  equal(agents.created.length, 1)
  equal(record.agent.id, agents.created[0].id)
  equal(record.resumed, false)
  equal(record.agent.options.provider, undefined)
})

test('passes provider and model agent options', async () => {
  const agents = makeAgents()
  const sessions = createChatSessions({ ctx: { agents, get: () => undefined }, config: { cwd: '/tmp', provider: 'p1', model: 'm1' }, logger: makeLogger() })
  await sessions.get(1)
  equal(agents.created[0].options.agentOptions, { provider: 'p1', model: 'm1' })
  equal(agents.created[0].options.meta, { cwd: '/tmp' })
})

test('resume is attempted from state and can fail gracefully', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tg-'))
  const stateFile = join(dir, 'state.json')
  const first = createChatSessions({ ctx: { agents: makeAgents(), get: () => undefined }, config: { cwd: '/tmp', stateFile }, logger: makeLogger() })
  const original = await first.get(7)
  assert(existsSync(stateFile), 'state file written')
  const saved = JSON.parse(readFileSync(stateFile, 'utf8'))
  equal(saved.chats['7'].sessionId, original.agent.session.id)

  const agents2 = makeAgents()
  const second = createChatSessions({ ctx: { agents: agents2, get: () => undefined }, config: { cwd: '/tmp', stateFile }, logger: makeLogger() })
  const resumed = await second.get(7)
  equal(agents2.resumed.length, 1)
  equal(resumed.agent.session.id, original.agent.session.id)
  equal(resumed.resumed, true)
})

test('resume failure falls back to a fresh session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tg-'))
  const stateFile = join(dir, 'state.json')
  const first = createChatSessions({ ctx: { agents: makeAgents(), get: () => undefined }, config: { cwd: '/tmp', stateFile }, logger: makeLogger() })
  await first.get(9)
  const agents2 = makeAgents({ resumeFails: true })
  const second = createChatSessions({ ctx: { agents: agents2, get: () => undefined }, config: { cwd: '/tmp', stateFile }, logger: makeLogger() })
  const record = await second.get(9)
  equal(record.resumed, false)
  equal(agents2.created.length, 1)
  assert(second.loggerInstance === undefined, 'no leak')
})

test('/new-style fresh get disposes the previous session', async () => {
  const agents = makeAgents()
  const sessions = createChatSessions({ ctx: { agents, get: () => undefined }, config: { cwd: '/tmp' }, logger: makeLogger() })
  const first = await sessions.get(5)
  const second = await sessions.get(5, { fresh: true })
  equal(agents.disposed, [first.agent.session.id])
  equal(second.agent.session.id, agents.created[1].id)
})

test('disposeAll disposes every chat session', async () => {
  const agents = makeAgents()
  const sessions = createChatSessions({ ctx: { agents, get: () => undefined }, config: { cwd: '/tmp' }, logger: makeLogger() })
  const a = await sessions.get(1)
  const b = await sessions.get(2)
  await sessions.disposeAll()
  equal(agents.disposed.length, 2)
  equal(sessions.size(), 0)
})

test('same chat returns the same record', async () => {
  const agents = makeAgents()
  const sessions = createChatSessions({ ctx: { agents, get: () => undefined }, config: { cwd: '/tmp' }, logger: makeLogger() })
  const a = await sessions.get(3)
  const b = await sessions.get(3)
  equal(a, b)
  equal(agents.created.length, 1)
})

test('mounts the configured agent preset on a fresh session', async () => {
  const agents = makeAgents()
  const presets = makePresets()
  const sessions = createChatSessions({
    ctx: { agents, get: (name) => (name === 'agentPresets' ? presets : undefined) },
    config: { cwd: '/tmp', agentPreset: 'standard' },
    logger: makeLogger(),
  })
  await sessions.get(21)
  equal(agents.created[0].options.meta, { cwd: '/tmp', agentPreset: 'standard' })
  equal(presets.mounts.map((m) => m.id), ['standard'])
  equal(agents.setups.length, 1)
  equal(agents.setups[0].ctx, presets.mounts[0].agentCtx)
})

test('mounts the configured agent preset on resume too', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tg-'))
  const stateFile = join(dir, 'state.json')
  const first = createChatSessions({ ctx: { agents: makeAgents(), get: () => undefined }, config: { cwd: '/tmp', stateFile }, logger: makeLogger() })
  const original = await first.get(8)

  const agents2 = makeAgents()
  const presets = makePresets()
  const second = createChatSessions({
    ctx: { agents: agents2, get: (name) => (name === 'agentPresets' ? presets : undefined) },
    config: { cwd: '/tmp', stateFile, agentPreset: 'standard' },
    logger: makeLogger(),
  })
  const resumed = await second.get(8)
  equal(resumed.agent.session.id, original.agent.session.id)
  equal(agents2.resumed.length, 1)
  equal(presets.mounts.map((m) => m.id), ['standard'])
})

test('an unmounted agentPresets service keeps the composition defaults', async () => {
  const agents = makeAgents()
  const logger = makeLogger()
  const sessions = createChatSessions({
    ctx: { agents, get: () => undefined },
    config: { cwd: '/tmp', agentPreset: 'standard' },
    logger,
  })
  await sessions.get(22)
  equal(agents.created[0].options.meta, { cwd: '/tmp' })
  equal(agents.created[0].options.setup, undefined)
  assert(logger.lines.some((l) => l.includes('agentPresets')), 'warns about the unmounted registry')
})

test('an unresolvable agentPreset warns and still creates the session', async () => {
  const agents = makeAgents()
  const presets = makePresets({ failResolve: true })
  const logger = makeLogger()
  const sessions = createChatSessions({
    ctx: { agents, get: (name) => (name === 'agentPresets' ? presets : undefined) },
    config: { cwd: '/tmp', agentPreset: 'nope' },
    logger,
  })
  await sessions.get(23)
  equal(presets.mounts.length, 0)
  equal(agents.created[0].options.meta, { cwd: '/tmp' })
  assert(logger.lines.some((l) => l.includes('did not resolve')), 'warns about the unknown preset')
})

test('lookup routes by session id', async () => {
  const agents = makeAgents()
  const sessions = createChatSessions({ ctx: { agents, get: () => undefined }, config: { cwd: '/tmp' }, logger: makeLogger() })
  const record = await sessions.get(11)
  equal(sessions.lookup(record.agent.session.id), record)
  equal(sessions.lookup('nope'), undefined)
})

/** The chain the live config uses: NVIDIA first, then two DeepSeek V4.1 Flash hosts. */
const CHAIN_CONFIG = {
  cwd: '/tmp',
  provider: 'nvidia',
  model: 'z-ai/glm-5.3',
  fallbacks: [
    { provider: 'nvidia', model: 'moonshotai/kimi-k2.6' },
    { provider: 'nvidia', model: 'z-ai/glm-5.3-flash' },
    { provider: 'nvidia', model: 'deepseek-ai/deepseek-v4.1-flash' },
    { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
    { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
  ],
}

/** One turn's abort signal: the loop opens a fresh controller per turn. */
function newTurn() {
  return new AbortController()
}

/** Fail the agent's current request once with `code`; returns the listener decision and whether it delegated. */
async function failOnce(agentCtx, code, turn) {
  let delegated = false
  const decision = await callListener(agentCtx, 'agent/request-error', {
    failure: { code, message: code + ' failure' },
    signal: turn.signal,
  }, async () => { delegated = true; return undefined })
  return { decision, delegated }
}

/** The route the agent's next request in `turn` resolves to, given the loop's own proposal. */
async function routeOf(agentCtx, proposed, turn) {
  const { provider, model, reasoningEffort } = await callListener(agentCtx, 'agent/request', { signal: turn.signal }, async () => proposed)
  return reasoningEffort === undefined ? { provider, model } : { provider, model, reasoningEffort }
}

test('walks the fallback chain in order, one route per failure', async () => {
  const agents = makeAgents()
  const logger = makeLogger()
  const sessions = createChatSessions({ ctx: { agents, get: () => undefined }, config: CHAIN_CONFIG, logger })
  await sessions.get(31)
  const agentCtx = agents.setups[0].ctx
  const primary = { provider: 'nvidia', model: 'z-ai/glm-5.3', reasoningEffort: 'max' }
  const turn = newTurn()

  equal(await routeOf(agentCtx, primary, turn), primary, 'the primary route is left alone until a failure')

  const expected = [
    ['RATE_LIMIT', { provider: 'nvidia', model: 'moonshotai/kimi-k2.6' }],
    ['UNKNOWN', { provider: 'nvidia', model: 'z-ai/glm-5.3-flash' }],
    ['TIMEOUT', { provider: 'nvidia', model: 'deepseek-ai/deepseek-v4.1-flash' }],
    ['SERVER', { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }],
    ['QUOTA', { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' }],
  ]
  for (const [code, route] of expected) {
    const { decision, delegated } = await failOnce(agentCtx, code, turn)
    equal(decision, { kind: 'retry' }, code + ' moves to the next route')
    equal(delegated, false, 'the chain owns recovery while routes remain')
    equal(await routeOf(agentCtx, primary, turn), route, 'the inherited effort is replaced by the route\'s own')
  }
  assert(logger.lines.some((line) => line.includes('nvidia/z-ai/glm-5.3 (RATE_LIMIT)') && line.includes('nvidia/moonshotai/kimi-k2.6 (fallback 1/5)')), 'first switch is logged')
  assert(logger.lines.some((line) => line.includes('deepseek-official/deepseek-flash (fallback 5/5)')), 'last switch is logged')

  const last = await failOnce(agentCtx, 'QUOTA', turn)
  equal(last.decision, undefined)
  equal(last.delegated, true, 'a failure on the last route is delegated, not retried forever')
})

test('the next turn starts again on the primary route', async () => {
  const agents = makeAgents()
  const sessions = createChatSessions({ ctx: { agents, get: () => undefined }, config: CHAIN_CONFIG, logger: makeLogger() })
  await sessions.get(38)
  const agentCtx = agents.setups[0].ctx
  const primary = { provider: 'nvidia', model: 'z-ai/glm-5.3' }
  const kimi = { provider: 'nvidia', model: 'moonshotai/kimi-k2.6' }

  const first = newTurn()
  await failOnce(agentCtx, 'RATE_LIMIT', first)
  equal(await routeOf(agentCtx, primary, first), kimi)
  // Later steps of the same turn: the loop now proposes the logged (Kimi) header.
  equal(await routeOf(agentCtx, { ...kimi, maxTokens: 9 }, first), { ...kimi })

  // Next turn: the loop still proposes the last logged header, and the chain
  // puts the primary back — without the inherited effort.
  const second = newTurn()
  equal(await routeOf(agentCtx, { ...kimi, reasoningEffort: 'high' }, second), primary)
  equal(await callListener(agentCtx, 'system-prompt/assemble', {}, { signal: second.signal }, async () => ({ variables: {} })), {
    variables: { provider: 'nvidia', model: 'z-ai/glm-5.3' },
  })
  // …and walks the whole chain again from the top.
  equal((await failOnce(agentCtx, 'SERVER', second)).decision, { kind: 'retry' })
  equal(await routeOf(agentCtx, primary, second), kimi)
})

test('a stopped turn never moves down the chain', async () => {
  const agents = makeAgents()
  const sessions = createChatSessions({ ctx: { agents, get: () => undefined }, config: CHAIN_CONFIG, logger: makeLogger() })
  await sessions.get(32)
  const agentCtx = agents.setups[0].ctx
  const primary = { provider: 'nvidia', model: 'z-ai/glm-5.3' }
  const turn = newTurn()
  turn.abort()

  const { decision, delegated } = await failOnce(agentCtx, 'TIMEOUT', turn)
  equal(decision, undefined)
  equal(delegated, true)
  equal(await routeOf(agentCtx, primary, turn), primary)
})

test('fallbackOn quota only follows budget failures', async () => {
  const agents = makeAgents()
  const logger = makeLogger()
  const sessions = createChatSessions({
    ctx: { agents, get: () => undefined },
    config: {
      cwd: '/tmp',
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      fallbacks: [{ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }],
      fallbackOn: 'quota',
    },
    logger,
  })
  await sessions.get(33)
  const agentCtx = agents.setups[0].ctx
  const primary = { provider: 'deepseek-official', model: 'deepseek-flash' }
  const turn = newTurn()

  const rateLimited = await failOnce(agentCtx, 'RATE_LIMIT', turn)
  equal(rateLimited.decision, undefined)
  equal(rateLimited.delegated, true)
  equal(await routeOf(agentCtx, primary, turn), primary)
  equal(logger.lines.some((line) => line.includes('retrying this turn')), false)

  const quota = await failOnce(agentCtx, 'ACCOUNT_QUOTA', turn)
  equal(quota.decision, { kind: 'retry' })
  equal(await routeOf(agentCtx, primary, turn), { provider: 'opencode-go', model: 'deepseek-v4.1-flash' })
})

test('the switched route feeds prompt assembly variables', async () => {
  const agents = makeAgents()
  const sessions = createChatSessions({ ctx: { agents, get: () => undefined }, config: CHAIN_CONFIG, logger: makeLogger() })
  await sessions.get(34)
  const agentCtx = agents.setups[0].ctx
  const turn = newTurn()
  const assembled = { variables: { provider: 'nvidia', model: 'z-ai/glm-5.3', other: 'keep' } }
  equal(await callListener(agentCtx, 'system-prompt/assemble', {}, { signal: turn.signal }, async () => assembled), assembled)

  await failOnce(agentCtx, 'ACCOUNT_QUOTA', turn)
  equal(await callListener(agentCtx, 'system-prompt/assemble', {}, { signal: turn.signal }, async () => assembled), {
    variables: { provider: 'nvidia', model: 'moonshotai/kimi-k2.6', other: 'keep' },
  })
  // An assembly outside any turn (no signal) does not reset the open turn's route.
  equal((await callListener(agentCtx, 'system-prompt/assemble', {}, {}, async () => assembled)).variables.model, 'moonshotai/kimi-k2.6')
})

test('fallbacks that repeat the primary or an earlier route are skipped', async () => {
  const agents = makeAgents()
  const logger = makeLogger()
  const sessions = createChatSessions({
    ctx: { agents, get: () => undefined },
    config: {
      cwd: '/tmp',
      provider: 'nvidia',
      model: 'z-ai/glm-5.3',
      fallbacks: [
        { provider: 'nvidia', model: 'z-ai/glm-5.3' },
        { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
        { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
      ],
    },
    logger,
  })
  await sessions.get(35)
  const agentCtx = agents.setups[0].ctx
  const primary = { provider: 'nvidia', model: 'z-ai/glm-5.3' }
  const turn = newTurn()

  equal((await failOnce(agentCtx, 'SERVER', turn)).decision, { kind: 'retry' })
  equal(await routeOf(agentCtx, primary, turn), { provider: 'opencode-go', model: 'deepseek-v4.1-flash' })
  const exhausted = await failOnce(agentCtx, 'SERVER', turn)
  equal(exhausted.delegated, true, 'the duplicate entry is not retried')
  assert(logger.lines.some((line) => line.includes('(fallback 1/1)')), 'chain length excludes duplicates')
})

test('a chain made only of the primary route is not installed', async () => {
  const agents = makeAgents()
  const sessions = createChatSessions({
    ctx: { agents, get: () => undefined },
    config: {
      cwd: '/tmp',
      provider: 'opencode-go',
      model: 'deepseek-v4.1-flash',
      fallbacks: [{ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }],
    },
    logger: makeLogger(),
  })
  await sessions.get(36)
  equal(agents.created[0].options.setup, undefined)
})

test('a resumed session starts again on its primary route', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slack-chain-'))
  const stateFile = join(dir, 'state.json')
  const firstAgents = makeAgents()
  const first = createChatSessions({ ctx: { agents: firstAgents, get: () => undefined }, config: { ...CHAIN_CONFIG, stateFile }, logger: makeLogger() })
  await first.get(37)
  await failOnce(firstAgents.setups[0].ctx, 'QUOTA', newTurn())

  const agents = makeAgents()
  const second = createChatSessions({ ctx: { agents, get: () => undefined }, config: { ...CHAIN_CONFIG, stateFile }, logger: makeLogger() })
  await second.get(37)
  equal(agents.resumed.length, 1, 'the mapped session is resumed')
  const resumedCtx = agents.setups[0].ctx
  const primary = { provider: 'nvidia', model: 'z-ai/glm-5.3' }
  const turn = newTurn()
  equal(await routeOf(resumedCtx, primary, turn), primary)
  equal((await failOnce(resumedCtx, 'QUOTA', turn)).decision, { kind: 'retry' })
  equal(await routeOf(resumedCtx, primary, turn), { provider: 'nvidia', model: 'moonshotai/kimi-k2.6' })
  rmSync(dir, { recursive: true, force: true })
})

test('slackSurface installs the Slack surface on created and resumed sessions alike', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slack-surface-'))
  const stateFile = join(dir, 'state.json')
  const config = { cwd: '/tmp', slackSurface: true, stateFile }
  const firstAgents = makeAgents()
  const first = createChatSessions({ ctx: { agents: firstAgents, get: () => undefined }, config, logger: makeLogger() })
  await first.get(38)
  equal(firstAgents.created.length, 1)
  assert((firstAgents.setups[0].ctx.listeners['tools/post-execute'] ?? []).length === 1, 'fresh session gets token redaction')

  const agents = makeAgents()
  const logger = makeLogger()
  const second = createChatSessions({ ctx: { agents, get: () => undefined }, config, logger })
  await second.get(38)
  equal(agents.resumed.length, 1, 'the mapped session is resumed')
  assert((agents.setups[0].ctx.listeners['tools/post-execute'] ?? []).length === 1, 'resumed session gets it too')
  assert(logger.lines.some((l) => l.includes('systemPrompt')), 'a context without the services warns instead of failing')
  rmSync(dir, { recursive: true, force: true })
})

test('without slackSurface a session with no preset or chain keeps no setup', async () => {
  const agents = makeAgents()
  const sessions = createChatSessions({ ctx: { agents, get: () => undefined }, config: { cwd: '/tmp', slackSurface: false }, logger: makeLogger() })
  await sessions.get(39)
  equal(agents.created[0].options.setup, undefined)
})

test('after the cooldown the turn tries its primary again, then walks the chain from the top', async () => {
  const agents = makeAgents()
  let clock = 1_000_000
  const sessions = createChatSessions({
    ctx: { agents, get: () => undefined },
    config: { ...CHAIN_CONFIG, fallbackCooldownMs: 120_000 },
    logger: makeLogger(),
    now: () => clock,
  })
  await sessions.get(40)
  const agentCtx = agents.setups[0].ctx
  const primary = { provider: 'nvidia', model: 'z-ai/glm-5.3' }
  const turn = newTurn()
  for (let i = 0; i < 4; i++) await failOnce(agentCtx, 'RATE_LIMIT', turn)
  const opencode = { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }
  equal(await routeOf(agentCtx, primary, turn), opencode, 'the 429 burst reached opencode-go')
  clock += 119_999
  equal(await routeOf(agentCtx, opencode, turn), opencode, 'still inside the cooldown')
  clock += 1
  equal(await routeOf(agentCtx, opencode, turn), primary, 'cooldown over: the same turn is back on the primary')
  equal((await failOnce(agentCtx, 'RATE_LIMIT', turn)).decision, { kind: 'retry' })
  equal(await routeOf(agentCtx, primary, turn), { provider: 'nvidia', model: 'moonshotai/kimi-k2.6' }, 'a primary that still fails walks the chain again')
})

test('without a cooldown the fallback holds for the rest of the turn', async () => {
  const agents = makeAgents()
  let clock = 0
  const sessions = createChatSessions({ ctx: { agents, get: () => undefined }, config: CHAIN_CONFIG, logger: makeLogger(), now: () => clock })
  await sessions.get(41)
  const agentCtx = agents.setups[0].ctx
  const turn = newTurn()
  await failOnce(agentCtx, 'RATE_LIMIT', turn)
  clock += 24 * 60 * 60 * 1000
  equal(await routeOf(agentCtx, { provider: 'nvidia', model: 'z-ai/glm-5.3' }, turn), { provider: 'nvidia', model: 'moonshotai/kimi-k2.6' })
})

await sleep(1)

/** A live agent another owner (the host's schedule delivery, the Web UI) holds. */
function makeLiveAgent(id) {
  return { id, session: { id, header: { id } }, ctx: makeAgentCtx(id) }
}

function ownedError(id) {
  const error = new Error('session "' + id + '" is already owned by an active write handle')
  error.name = 'SessionAlreadyOwnedError'
  return error
}

test('a mapped session the host holds live is joined, not replaced by a fresh one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-live-'))
  const stateFile = join(dir, 'state.json')
  const config = { cwd: '/tmp', slackSurface: true, stateFile }
  const first = createChatSessions({ ctx: { agents: makeAgents(), get: () => undefined }, config, logger: makeLogger() })
  const original = await first.get('C1:100.1', { channel: 'C1' })
  const id = original.agent.session.id

  const liveAgent = makeLiveAgent(id)
  const agents = makeAgents({ live: new Map([[id, liveAgent]]), resumeError: () => ownedError(id) })
  const logger = makeLogger()
  const second = createChatSessions({ ctx: { agents, get: () => undefined }, config, logger })
  const record = await second.get('C1:100.1', { channel: 'C1' })
  assert(record.agent === liveAgent, 'the live agent itself drives the thread')
  equal(record.resumed, true)
  equal(record.fresh, false)
  equal(agents.created.length, 0, 'no fresh session')
  equal(agents.resumed.length, 0, 'no second copy is resumed')
  equal(JSON.parse(readFileSync(stateFile, 'utf8')).chats['C1:100.1'].sessionId, id, 'the thread keeps its session')
  equal((liveAgent.ctx.listeners['tools/post-execute'] ?? []).length, 1, 'the Slack surface is installed on the joined agent')
  assert(logger.lines.some((l) => l.includes('joining it')), 'the join is logged')

  await second.disposeAll()
  equal(agents.disposed, [], 'disposing the channel leaves the owner its agent')
  rmSync(dir, { recursive: true, force: true })
})

test('joining the same live agent after a plugin reload installs the channel listeners once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-live-'))
  const stateFile = join(dir, 'state.json')
  const config = { cwd: '/tmp', slackSurface: true, stateFile }
  const first = createChatSessions({ ctx: { agents: makeAgents(), get: () => undefined }, config, logger: makeLogger() })
  const id = (await first.get('C1:200.1', { channel: 'C1' })).agent.session.id
  const liveAgent = makeLiveAgent(id)
  for (let generation = 0; generation < 2; generation++) {
    const sessions = createChatSessions({ ctx: { agents: makeAgents({ live: new Map([[id, liveAgent]]) }), get: () => undefined }, config, logger: makeLogger() })
    const record = await sessions.get('C1:200.1', { channel: 'C1' })
    assert(record.agent === liveAgent, 'generation ' + generation + ' joins the live agent')
    await sessions.disposeAll()
  }
  equal((liveAgent.ctx.listeners['tools/post-execute'] ?? []).length, 1, 'one redaction listener, not one per reload')
  rmSync(dir, { recursive: true, force: true })
})

test('a session that goes live while the resume runs is joined', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-live-'))
  const stateFile = join(dir, 'state.json')
  const first = createChatSessions({ ctx: { agents: makeAgents(), get: () => undefined }, config: { cwd: '/tmp', stateFile }, logger: makeLogger() })
  const id = (await first.get('C1:300.1', { channel: 'C1' })).agent.session.id
  const live = new Map()
  const liveAgent = makeLiveAgent(id)
  const agents = makeAgents({
    live,
    resumeError: () => {
      live.set(id, liveAgent)
      return ownedError(id)
    },
  })
  const second = createChatSessions({ ctx: { agents, get: () => undefined }, config: { cwd: '/tmp', stateFile }, logger: makeLogger() })
  const record = await second.get('C1:300.1', { channel: 'C1' })
  assert(record.agent === liveAgent, 'the raced agent is joined')
  equal(agents.created.length, 0)
  rmSync(dir, { recursive: true, force: true })
})

test('a write lock held outside this process keeps the thread mapping instead of forking', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-live-'))
  const stateFile = join(dir, 'state.json')
  const first = createChatSessions({ ctx: { agents: makeAgents(), get: () => undefined }, config: { cwd: '/tmp', stateFile }, logger: makeLogger() })
  const id = (await first.get('C1:400.1', { channel: 'C1' })).agent.session.id
  const agents = makeAgents({ resumeError: () => ownedError(id) })
  const second = createChatSessions({ ctx: { agents, get: () => undefined }, config: { cwd: '/tmp', stateFile }, logger: makeLogger() })
  let rejected
  try {
    await second.get('C1:400.1', { channel: 'C1' })
  } catch (error) {
    rejected = error
  }
  assert(rejected?.name === 'SessionAlreadyOwnedError', 'the conflict reaches the caller')
  equal(agents.created.length, 0, 'no fresh session')
  equal(JSON.parse(readFileSync(stateFile, 'utf8')).chats['C1:400.1'].sessionId, id, 'the mapping is kept')
  rmSync(dir, { recursive: true, force: true })
})
