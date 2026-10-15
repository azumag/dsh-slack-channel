// Chat-session manager tests with a fake agents registry.

import { test, assert, equal, sleep } from './_util.mjs'
import { createChatSessions } from '../src/sessions.js'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
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

function makeAgents({ resumeFails = false } = {}) {
  const created = []
  const resumed = []
  const disposed = []
  const setups = []
  let counter = 0
  return {
    created, resumed, disposed, setups,
    async create(options) {
      const id = options.sessionId ?? ('gen-' + (++counter))
      if (options.setup !== undefined) {
        const agentCtx = { scope: 'agent:' + id }
        setups.push({ id, ctx: agentCtx })
        await options.setup(agentCtx, { id, session: { id } })
      }
      const agent = { id, session: { id, header: { id } }, options }
      created.push(agent)
      return { agent, dispose: async () => { disposed.push(id) } }
    },
    async resume(options) {
      if (resumeFails) throw new Error('persistence not configured')
      const id = options.resumeSessionId
      if (options.setup !== undefined) {
        const agentCtx = { scope: 'agent:' + id }
        setups.push({ id, ctx: agentCtx })
        await options.setup(agentCtx, { id, session: { id } })
      }
      const agent = { id, session: { id, header: { id } }, options }
      resumed.push(agent)
      return { agent, dispose: async () => { disposed.push(id) } }
    },
  }
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

await sleep(1)
