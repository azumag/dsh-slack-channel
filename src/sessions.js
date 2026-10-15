// Per-chat agent session management: one live agent (own session) per
// Telegram chat, created through ctx.agents the same way the in-repo ACP
// bridge creates its sessions. Optional state-file persistence records the
// chat-to-session mapping so a restart resumes conversations instead of
// silently starting over.

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

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

/**
 * Build the chat-session manager.
 * @param options.ctx - the cordis context carrying the agents registry.
 * @param options.config - validated plugin config (provider/model/cwd/stateFile).
 * @param options.logger - named plugin logger.
 */
export function createChatSessions({ ctx, config, logger }) {
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
   */
  async function composeAgent() {
    if (config.agentPreset === undefined) return {}
    const presets = ctx.get('agentPresets')
    if (presets === undefined) {
      logger.warn('agentPreset configured but no agentPresets service is mounted; keeping composition defaults')
      return {}
    }
    let resolvedId
    try {
      resolvedId = (await presets.resolve(config.agentPreset)).id
    } catch (error) {
      logger.warn('agentPreset ' + JSON.stringify(config.agentPreset) + ' did not resolve: ' + (error?.message ?? String(error)))
      return {}
    }
    return {
      agentPreset: resolvedId,
      setup: async (agentCtx) => { await presets.mount(agentCtx, resolvedId) },
    }
  }

  async function create(chatId, resumeSessionId) {
    // Channel-scoped workspace first (the Slack-section ↔ DSH-workspace
    // mapping), then the plugin-wide workspace, then the server's cwd.
    const cwd = config.channelCwd?.[String(chatId)] ?? config.cwd ?? process.cwd()
    // Composed once per create/resume so the resume and the fresh path mount
    // the same preset revision.
    const composition = await composeAgent()
    let handle
    let resumed = false
    if (resumeSessionId !== undefined) {
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
          agentOptions: agentOptions(),
          ...(composition.setup === undefined ? {} : { setup: composition.setup }),
        })
        resumed = true
      } catch (error) {
        if (String(error?.message ?? error).includes('while it is live')) {
          // The mapped session is open in another surface (e.g. the web UI
          // holds it). Falling back to a fresh session here would silently
          // abandon the mapped conversation and overwrite this mapping via
          // saveState — surface the conflict and keep the mapping instead.
          throw error
        }
        logger.warn('resume of session ' + resumeSessionId + ' failed (' + (error?.message ?? String(error)) + '); starting a fresh session')
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
        agentOptions: agentOptions(),
        ...(composition.setup === undefined ? {} : { setup: composition.setup }),
      })
      applyPermissionPreset(handle)
    }
    return {
      chatId,
      agent: handle.agent,
      dispose: handle.dispose,
      resumed,
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
   * Return the live record for a chat, creating (or resuming) one on first
   * use. fresh=true disposes the previous record first (the /new command).
   */
  async function get(chatId, { fresh = false } = {}) {
    const key = String(chatId)
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
    const record = await create(chatId, known)
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

  /** The record for a chat id, if one is live. */
  function record(chatId) {
    return byChat.get(String(chatId))
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

  return { get, lookup, record, stopTyping, disposeAll, enroll, isEnrolled, size: () => byChat.size }
}
