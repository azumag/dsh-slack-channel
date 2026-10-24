// Per-conversation agent session management: one live agent (own session)
// per conversation key, created through ctx.agents the same way the in-repo
// ACP bridge creates its sessions. The key is the Slack channel id
// (sessionScope: channel) or "channel:thread root ts" (sessionScope: thread);
// each record also carries its Slack channel id (chatId) for posting. Optional
// state-file persistence records the key-to-session mapping so a restart
// resumes conversations instead of silently starting over.

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { installSlackSurface } from './surface.js'

/** Load the persisted chat map, tolerating absent or corrupt files. */
function loadState(stateFile) {
  if (stateFile === undefined) return { version: 1, chats: {}, enrolled: [] }
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && parsed.chats !== null && typeof parsed.chats === 'object') {
      if (Array.isArray(parsed.enrolled) !== true) parsed.enrolled = []
      return parsed
    }
  } catch { /* absent or corrupt: start empty */ }
  return { version: 1, chats: {}, enrolled: [] }
}

/** Request-failure codes that mean the provider budget, not the request, is exhausted. */
const QUOTA_FAILURE_CODES = new Set(['QUOTA', 'ACCOUNT_QUOTA'])

/** globalThis key of the live agents this plugin joined, shared across plugin reloads. */
const JOINED_AGENTS = Symbol.for('dsh-slack-channel.joined-agents')

/**
 * Whether a resume failed because someone else owns the session: its write
 * lock (dsh-session-persistence `SessionAlreadyOwnedError`), or the agent
 * registry already holding that id.
 */
function isHeldElsewhere(error) {
  if (error?.name === 'SessionAlreadyOwnedError') return true
  const message = String(error?.message ?? error)
  return message.includes('already owned by an active write handle')
    || message.includes('is already registered')
    || message.includes('while it is live')
}

function sameRoute(a, b) {
  return a.provider === b.provider && a.model === b.model
}

/**
 * The fallback chain for an agent whose own route is `primary`: the configured
 * routes in order, minus any that repeat the primary or an earlier entry —
 * retrying the same route once more would only delay the next real fallback.
 * @param cfg - validated plugin config.
 * @param primary - route the agent is created or resumed with.
 * @returns routes to try in order after a failure; empty when the fallback is off.
 */
function fallbackChain(cfg, primary) {
  const chain = []
  for (const route of cfg.fallbacks ?? []) {
    if (sameRoute(route, primary) || chain.some((seen) => sameRoute(seen, route))) continue
    chain.push(route)
  }
  return chain
}

/**
 * Retry one agent's failed model request on the next route of the chain. The
 * listeners are agent-scoped: the request override runs again for every
 * attempt, so returning `retry` from `agent/request-error` makes the loop's
 * next attempt use the next route in the same turn. They are registered after
 * the profile's llm-retry listener, which wraps them: a retryable failure
 * (RATE_LIMIT, SERVER, TIMEOUT …) reaches this chain only once that provider's
 * own retry policy has given up. A failure on the last route is delegated
 * instead of retried forever.
 *
 * Every turn starts again on the primary route, so a route that recovered is
 * used again instead of the session staying on a fallback for good. With a
 * cooldown the primary is also tried again inside the turn once that long has
 * passed since the last switch: NVIDIA's 429s clear within a minute or two,
 * but one Slack turn can run for hours, and on 2026-10-23 such turns spent
 * every remaining step (up to 416) on the opencode-go quota. A primary that
 * still fails walks the chain again from its first route. The loop
 * opens one AbortController per turn and hands its signal to every hook of
 * that turn, which is what marks the turn boundary here. The loop also seeds
 * each request from the last logged request header — after a switch that is
 * the fallback route — so the primary has to be put back explicitly.
 *
 * @param agentCtx - the agent's scoped context, supplied by `setup`.
 * @param primary - the agent's own route.
 * @param chain - routes to try in order (non-empty).
 * @param fallbackOn - 'any' failure, or 'quota' failures only.
 * @param logger - named plugin logger, for the switch warnings.
 * @param cooldownMs - time on a fallback before the primary is tried again in the same turn; 0 keeps it for the turn.
 * @param now - clock, injectable for tests.
 */
function installRouteFallback(agentCtx, primary, chain, fallbackOn, logger, cooldownMs = 0, now = Date.now) {
  /** Index of the route in use; -1 is the agent's own (primary) route. */
  let position = -1
  /** Signal of the turn the last switch happened in. */
  let switchedIn
  /** Whether any request of this agent ever left the primary route. */
  let switched = false
  /** When the last switch happened, for the cooldown. */
  let switchedAt = 0

  /**
   * The route requests of this turn must use, or undefined to leave the
   * loop's own proposal alone (no switch ever happened).
   * @param signal - the turn's abort signal; undefined outside a turn.
   */
  function routeFor(signal) {
    if (position >= 0 && signal !== undefined && signal !== switchedIn) position = -1
    if (position >= 0 && cooldownMs > 0 && now() - switchedAt >= cooldownMs) {
      logger.info('fallback cooldown over; trying ' + primary.provider + '/' + primary.model + ' again')
      position = -1
    }
    if (position >= 0) return chain[position]
    return switched ? primary : undefined
  }

  agentCtx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const selected = routeFor(context?.signal)
    const assembled = await next()
    if (selected === undefined) return assembled
    return {
      ...assembled,
      variables: { ...assembled.variables, provider: selected.provider, model: selected.model },
    }
  })

  agentCtx.on('agent/request', async (payload, next) => {
    const resolved = await next()
    const selected = routeFor(payload?.signal)
    if (selected === undefined || sameRoute(selected, resolved)) return resolved
    const { reasoningEffort: _inheritedEffort, ...rest } = resolved
    return {
      ...rest,
      provider: selected.provider,
      model: selected.model,
      ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
    }
  })

  agentCtx.on('agent/request-error', async (payload, next) => {
    const from = routeFor(payload?.signal) ?? primary
    if (position + 1 >= chain.length || payload?.signal?.aborted === true) return next()
    const code = payload?.failure?.code
    if (fallbackOn === 'quota' && !QUOTA_FAILURE_CODES.has(code)) return next()
    position += 1
    switchedIn = payload?.signal
    switched = true
    switchedAt = now()
    const to = chain[position]
    logger.warn('model request failed on ' + from.provider + '/' + from.model + ' (' + code + '); retrying this turn on '
      + to.provider + '/' + to.model + ' (fallback ' + (position + 1) + '/' + chain.length + ')')
    return { kind: 'retry' }
  })
}

/**
 * Build the chat-session manager.
 * @param options.ctx - the cordis context carrying the agents registry.
 * @param options.config - validated plugin config (provider/model/cwd/stateFile).
 * @param options.logger - named plugin logger.
 * @param options.selfUserId - getter for this bot's Slack user id (undefined until auth.test answers).
 * @param options.now - clock for the fallback cooldown, injectable for tests.
 */
export function createChatSessions({ ctx, config, logger, selfUserId, now = Date.now }) {
  const byChat = new Map()
  const bySession = new Map()
  let state = loadState(config.stateFile)
  /** Chats enrolled via the /pair flow; merged into authorization. */
  const enrolled = new Set(state.enrolled.map(String))

  function agentOptions() {
    const options = {}
    if (config.provider !== undefined) options.provider = config.provider
    if (config.model !== undefined) options.model = config.model
    // Unset route fields fall back to the deployment default route (the
    // `agent-default-model` settings row), mirroring how the host API proxy
    // seeds the agents it creates. Optional service: `ctx.get` yields
    // undefined when the composition does not mount agent-default-model.
    // Without any route, the persona's strict {{model}} reference and the
    // request dispatch both fail before the first model call.
    if (options.provider === undefined || options.model === undefined) {
      const fallback = ctx.get('agentDefaultModel')?.currentSelection()
      if (options.provider === undefined && fallback?.provider !== undefined) options.provider = fallback.provider
      if (options.model === undefined && fallback?.model !== undefined) options.model = fallback.model
    }
    return options
  }

  /**
   * Pin the configured permission preset onto a freshly created session —
   * the same write path the web UI's preset switcher uses (permission/preset
   * plus its sandbox/approval knob transitions), so a channel session starts
   * with the same sandbox and approval knobs as a web session. Resumed
   * sessions keep the knobs their log already carries, matching the web rule
   * that a settings change never rewrites an open conversation. Optional
   * config over an optional service: unset preset or an unmounted
   * permissionPresets service keeps the composition defaults, and a failed
   * application is contained — the session still works with default knobs.
   */
  function applyPermissionPreset(handle) {
    if (config.permissionPreset === undefined) return
    const presets = ctx.get('permissionPresets')
    if (presets === undefined) {
      logger.warn('permissionPreset configured but no permissionPresets service is mounted; keeping composition defaults')
      return
    }
    try {
      presets.set(handle.agent.session, config.permissionPreset)
    } catch (error) {
      logger.warn('permissionPreset ' + JSON.stringify(config.permissionPreset) + ' not applied: ' + (error?.message ?? String(error)))
    }
  }

  /**
   * Resolve the configured Agent preset and the pre-publication setup that
   * mounts it — the same composition step the Web session controller performs
   * (`dsh-api-session-controller`'s composeAgent, via agentPresets.resolve +
   * mount). The preset is what supplies the session's tool plugins, prompt
   * sections and skills: without one a channel session sees only the plugins
   * the profile mounts globally (its MCP servers, the workspace dependency
   * tools), which is why a channel agent cannot read repository files or run
   * `gh` unless a preset is mounted here. Optional config over an optional
   * service: an unset preset, an unmounted registry, or a resolve failure
   * keeps the composition defaults and only warns, so the channel still
   * answers.
   *
   * The same setup installs the fallback chain when configured, so fresh and
   * resumed sessions switch routes on a failed request without rebuilding the
   * preset. Fallbacks identical to the agent's own route are dropped: they
   * would retry the same route once more for no benefit. With `slackSurface`
   * it also tells the agent it is on Slack and guards the Slack API (see
   * surface.js) — on resume too, so an existing thread session is covered.
   *
   * @param options - route the agent is created or resumed with.
   * @returns preset selection and setup, or an empty object when neither applies.
   */
  async function composeAgent(options) {
    const chain = fallbackChain(config, options)
    let presets
    let resolvedId
    if (config.agentPreset !== undefined) {
      presets = ctx.get('agentPresets')
      if (presets === undefined) {
        logger.warn('agentPreset configured but no agentPresets service is mounted; keeping composition defaults')
      } else {
        try {
          resolvedId = (await presets.resolve(config.agentPreset)).id
        } catch (error) {
          logger.warn('agentPreset ' + JSON.stringify(config.agentPreset) + ' did not resolve: ' + (error?.message ?? String(error)))
        }
      }
    }
    const surface = config.slackSurface === true
    if (resolvedId === undefined && chain.length === 0 && !surface) return {}
    // The channel's own listeners, without the preset: a live agent this
    // plugin joins (see adopt) was already composed by its owner, so
    // mounting the preset again would register its tools twice.
    const channelSetup = (agentCtx) => {
      if (chain.length > 0) installRouteFallback(agentCtx, options, chain, config.fallbackOn ?? 'any', logger, config.fallbackCooldownMs ?? 0, now)
      if (surface) installSlackSurface(agentCtx, { config, selfUserId, logger })
    }
    return {
      ...(resolvedId === undefined ? {} : { agentPreset: resolvedId }),
      setup: async (agentCtx) => {
        if (resolvedId !== undefined && presets !== undefined) await presets.mount(agentCtx, resolvedId)
        channelSetup(agentCtx)
      },
      ...(chain.length === 0 && !surface ? {} : { channelSetup }),
    }
  }

  /**
   * Join a mapped session that is already live in this process instead of
   * resuming a second copy of it. The host keeps a session live after it
   * resumed it to deliver a schedule reminder (and the Web UI holds the one it
   * shows); resuming then fails on the session's write lock, and starting a
   * fresh session instead silently cut the thread off from its history (8
   * threads, 2026-10-19..22, each right after a `[SCHEDULE REMINDER BATCH]`
   * turn). The owner keeps the agent: dispose only drops this plugin's record.
   * The channel listeners go onto the agent once per agent, across plugin
   * reloads too (a registry on globalThis, keyed by the agent object), since
   * a second fallback chain or surface section would act twice; after a
   * reload the joined agent keeps the listeners its first join installed.
   * @param agent - the live agent from the registry.
   * @param composition - the result of composeAgent for this route.
   * @returns a handle shaped like ctx.agents.resume's.
   */
  function adopt(agent, composition) {
    const joined = (globalThis[JOINED_AGENTS] ??= new WeakSet())
    if (composition.channelSetup !== undefined && !joined.has(agent)) {
      if (agent.ctx === undefined) {
        logger.warn('joined live session ' + agent.id + ' exposes no agent context; it runs without the channel fallback chain and Slack surface')
      } else {
        try {
          composition.channelSetup(agent.ctx)
          joined.add(agent)
        } catch (error) {
          logger.warn('channel setup on live session ' + agent.id + ' failed: ' + (error?.message ?? String(error)))
        }
      }
    }
    logger.info('session ' + agent.id + ' is already live (its owner holds it); joining it instead of resuming a copy')
    return { agent, dispose: async () => {} }
  }

  async function create(key, chatId, resumeSessionId) {
    // Channel-scoped workspace first (the Slack-section ↔ DSH-workspace
    // mapping), then the plugin-wide workspace, then the server's cwd.
    const cwd = config.channelCwd?.[String(chatId)] ?? config.cwd ?? process.cwd()
    // One route for the create and the resume path, so the setup can tell
    // which configured fallbacks would just retry that same route.
    const options = agentOptions()
    // Composed once per create/resume so the resume and the fresh path mount
    // the same preset revision and install the same fallback listeners.
    const composition = await composeAgent(options)
    let handle
    let resumed = false
    const live = resumeSessionId === undefined ? undefined : ctx.agents.get?.(resumeSessionId)
    if (live !== undefined) {
      handle = adopt(live, composition)
      resumed = true
    } else if (resumeSessionId !== undefined) {
      try {
        // Resumed agents seed their first request route from their options
        // (a fresh loop instance has no logged header of its own), so the
        // resume MUST carry the same route fresh creates get — otherwise the
        // persona's strict {{model}} reference fails the first message. The
        // setup callback mounts the preset again: a session created before the
        // setting existed gains its tools on the next resume, matching how the
        // Web controller re-mounts on resume.
        handle = await ctx.agents.resume({
          resumeSessionId,
          agentOptions: options,
          ...(composition.setup === undefined ? {} : { setup: composition.setup }),
        })
        resumed = true
      } catch (error) {
        // The session went live while this resume ran (the host resumed it
        // for a reminder at the same moment): join that agent.
        const raced = ctx.agents.get?.(resumeSessionId)
        if (raced !== undefined) {
          handle = adopt(raced, composition)
          resumed = true
        } else if (isHeldElsewhere(error)) {
          // The write lock is held outside this process (another DSH process
          // has the session open). Falling back to a fresh session here would
          // silently abandon the mapped conversation and overwrite this
          // mapping via saveState — surface the conflict and keep the mapping.
          throw error
        } else {
          logger.warn('resume of session ' + resumeSessionId + ' failed (' + (error?.message ?? String(error)) + '); starting a fresh session')
        }
      }
    }
    if (handle === undefined) {
      handle = await ctx.agents.create({
        sessionId: randomUUID(),
        meta: {
          cwd,
          // Recorded in the session header so a later reader (Web UI adoption,
          // transcript readers) sees which preset composed this session.
          ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }),
        },
        agentOptions: options,
        ...(composition.setup === undefined ? {} : { setup: composition.setup }),
      })
      applyPermissionPreset(handle)
    }
    return {
      /** The conversation key (channel, or channel:thread root). */
      key,
      /** The Slack channel id the conversation lives in. */
      chatId,
      agent: handle.agent,
      dispose: handle.dispose,
      resumed,
      /**
       * True until the first turn is submitted to a CREATED (not resumed)
       * session: it has no conversation history yet. The channel clears it.
       */
      fresh: resumed === false,
      /** Messages waiting while the agent works; drained FIFO on settle. */
      queue: [],
      busy: false,
      /** Committed assistant texts of the open turn, in arrival order. */
      turnTexts: [],
      /** Collected texts of the finished-but-undelivered turn. */
      finishedText: undefined,
      collector: undefined,
      typingTimer: undefined,
    }
  }

  /**
   * Return the live record for a conversation, creating (or resuming) one on
   * first use. fresh=true disposes the previous record first (the /new
   * command). `channel` is the Slack channel id when the key is a thread key;
   * a plain channel key is its own channel.
   */
  async function get(conversation, { fresh = false, channel } = {}) {
    const key = String(conversation)
    const chatId = channel ?? key
    if (fresh === false) {
      const existing = byChat.get(key)
      if (existing !== undefined) return existing
    }
    const previous = byChat.get(key)
    if (previous !== undefined) {
      stopTyping(previous)
      byChat.delete(key)
      bySession.delete(previous.agent.session.id)
      try {
        await previous.dispose()
      } catch (error) {
        logger.warn('dispose of previous session failed: ' + (error?.message ?? String(error)))
      }
    }
    const known = fresh === true ? undefined : state.chats[key]?.sessionId
    const record = await create(key, chatId, known)
    byChat.set(key, record)
    bySession.set(record.agent.session.id, record)
    state.chats[key] = { sessionId: record.agent.session.id, updatedAt: new Date().toISOString() }
    saveState()
    return record
  }

  /** The record owning exactly this session id, for event routing. */
  function lookup(sessionId) {
    return bySession.get(sessionId)
  }

  /** The record for a conversation key, if one is live. */
  function record(conversation) {
    return byChat.get(String(conversation))
  }

  function stopTyping(record) {
    if (record.typingTimer !== undefined) {
      clearInterval(record.typingTimer)
      record.typingTimer = undefined
    }
  }

  function saveState() {
    if (config.stateFile === undefined) return
    try {
      mkdirSync(dirname(config.stateFile), { recursive: true })
      const tmp = config.stateFile + '.tmp'
      writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n')
      renameSync(tmp, config.stateFile)
    } catch (error) {
      logger.warn('state file write failed: ' + (error?.message ?? String(error)))
    }
  }

  /**
   * Enroll one chat via the /pair flow: authorization merges the enrolled
   * set, and the id persists through the state file so it survives restarts.
   */
  function enroll(chatId) {
    const key = String(chatId)
    enrolled.add(key)
    if (state.enrolled.includes(key) === false) state.enrolled.push(key)
    saveState()
  }

  /** Whether a chat was enrolled through the pairing flow. */
  function isEnrolled(chatId) {
    return enrolled.has(String(chatId))
  }

  /** Dispose every live chat session (plugin teardown). */
  async function disposeAll() {
    const records = [...byChat.values()]
    byChat.clear()
    bySession.clear()
    for (const record of records) {
      stopTyping(record)
      try {
        await record.dispose()
      } catch (error) {
        logger.warn('session dispose failed: ' + (error?.message ?? String(error)))
      }
    }
  }

  return { get, lookup, record, all: () => [...byChat.values()], stopTyping, disposeAll, enroll, isEnrolled, size: () => byChat.size }
}
