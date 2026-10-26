// dsh-slack-channel: a Slack channel for DeepSeek Harness.
//
// Mounted like any cordis plugin (cordis.yml row or --patch overlay), the
// plugin runs a Slack Socket Mode connection (no public URL needed) and
// drives ONE live DSH agent session per channel through ctx.agents — the
// same in-process seam the ACP bridge uses for automation clients:
//
//   Slack message event -> createTextUserMessage -> agent.followup()
//   session/event (assistant/message) -> per-turn text collection
//   session/event (turn/end)          -> reply posted back to the channel
//
// Slack-specific handling: the bot's own messages come back as events
// (bot_id/subtype guard), replies post in-thread (thread_ts), and a reaction
// marks the message being worked on. Named exports for the cordis loader:
// name, inject, Config, apply.

import { createTurnCollector } from './collector.js'
import { toSlackMrkdwn } from './format.js'
import { createInteractions } from './interactions.js'
import { createTextUserMessage } from './message.js'
import { clearDrain, drainFile, receiveIsOff, receiveOffFile, writeDrain } from './handover.js'
import { pendingFile, savePending, takePending } from './pending.js'
import { Config } from './schema.js'
import { createChatSessions } from './sessions.js'
import { SlackClient, sleep, splitMessage } from './slack.js'
import { runSocketLoop } from './socket.js'

export { Config }

export const name = 'slack-channel'

/** The plugin creates and owns agents; everything else is composition-owned. */
export const inject = ['agents']

const HELP_TEXT = [
  'DeepSeek Harness agent channel.',
  'Commands (prefer the ! prefix — Slack intercepts leading / as its own slash commands):',
  '!new — start a fresh session (clears this conversation\'s memory)',
  '!stop — cancel the running turn',
  '!allow / !deny — answer the approval prompt this channel is waiting on',
  '!answer <text> — answer the question prompt in your own words',
  '!id — show this channel id (for allowedChannelIds)',
  '!pair <token> — enroll this channel (when pairToken is configured)',
  '!help — this text',
  'Anything else you post goes to the agent.',
].join('\n')

/**
 * Mount the Slack channel.
 * @param ctx - cordis context carrying the agents registry and event bus.
 * @param config - validated plugin configuration (see schema.js).
 */
export function apply(ctx, config) {
  const botToken = config.botToken ?? process.env.SLACK_BOT_TOKEN
  const appToken = config.appToken ?? process.env.SLACK_APP_TOKEN
  if (botToken === undefined || botToken.length === 0) {
    throw new Error('slack-channel: no bot token — set config.botToken or the SLACK_BOT_TOKEN environment variable')
  }
  if (appToken === undefined || appToken.length === 0) {
    throw new Error('slack-channel: no app token — set config.appToken or the SLACK_APP_TOKEN environment variable (Socket Mode needs the xapp- token)')
  }

  const logger = ctx.logger('slack-channel')
  const slack = new SlackClient({ apiBase: config.apiBase, botToken, appToken })
  // selfUserId is declared below and set once auth.test answers; the getter
  // is read at prompt assembly, long after apply() ran.
  const sessions = createChatSessions({ ctx, config, logger, selfUserId: () => selfUserId })
  const warnedChannels = new Set()
  const abort = new AbortController()
  /** Where waiting messages and interrupted turns wait out a reload (beside the state file). */
  const pendingPath = pendingFile(config.stateFile)
  /** While this file exists the channel receives nothing from Slack (handover, see handover.js). */
  const receiveOffPath = receiveOffFile(config.stateFile)
  const drainPath = drainFile(config.stateFile)
  let receiving = receiveIsOff(receiveOffPath) === false

  // Handed to every formatter call: model output is escaped wholesale, so the
  // ids in config.mentionUserIds are the only ones that survive as real Slack
  // mentions (see format.js). An empty allowlist keeps them all as text.
  const mrkdwnOptions = { mentionUserIds: config.mentionUserIds, mentionRewrites: config.mentionRewrites }

  // Interactive prompts (permission approvals and ask_user_question) for the
  // sessions this plugin owns are answered from Slack — see interactions.js.
  // `authorized` is hoisted, so the manager can capture it here.
  const interactions = createInteractions({ config, logger, slack, sessions, authorized, mrkdwnOptions, receiving: () => receiving })

  /**
   * Identities of THIS bot (auth.test's bot_id and user_id). Other
   * integrations post with their own bot_id, so the self-echo guard needs
   * ours to tell "another app" from "our own reply". Stays undefined until
   * the probe answers, and undefined keeps the strict filter.
   */
  let selfIds

  /**
   * This bot's own USER id (auth.test), the spelling a Slack mention uses.
   * Telling "did they mention us?" and addressing the answer back both need
   * it; undefined until the probe answers, like selfIds.
   */
  let selfUserId

  // Boot-time marker (dsh-a2a convention): the loader does not surface info
  // logs by default, so a direct stderr write confirms apply() ran.
  const channelSummary = config.allowAllChannels === true ? 'ALL' : (config.allowedChannelIds.length > 0 ? config.allowedChannelIds.join(',') : 'none')
  process.stderr.write('[dsh-slack-channel] apply: apiBase=' + config.apiBase + ', allowed channels: ' + channelSummary + '\n')

  /** The stable error text an event payload carries, for logging and replies. */
  function errorText(error) {
    return error?.message ?? String(error)
  }

  function authorized(channelId) {
    return config.allowAllChannels === true
      || config.allowedChannelIds.includes(channelId)
      || sessions.isEnrolled(channelId)
  }

  /**
   * Recognize a command verb from a message: leading "/" (the historical
   * spelling) or "!". Slack's own client intercepts "/"-messages as
   * (unregistered) slash commands — "Only visible to you" — so they never
   * reach the bot unless the sender prepends a space; the trim in
   * handleEvent normalizes that back. "!" is delivered verbatim and is the
   * reliable prefix in real Slack. Non-command text yields undefined.
   */
  function asCommand(text) {
    if (text.startsWith('!')) return text.slice(1)
    if (text.startsWith('/')) return text.slice(1)
    return undefined
  }

  /**
   * Whether the text mentions THIS bot, in the `<@U123>` spelling or the
   * legacy `<@U123|name>` one. An unresolved self id yields false, so a
   * failed probe can never make us answer a mention that was not ours.
   */
  function isSelfMention(text) {
    if (selfUserId === undefined) return false
    return text.includes('<@' + selfUserId + '>') || text.includes('<@' + selfUserId + '|')
  }

  /**
   * The user to mention back when answering this message, or undefined.
   * Humans who mention us are mentioned back. Other apps are only mentioned
   * back when `mentionBackBots` is on: the automatic ping is what closes a
   * two-agent loop, so the default is to answer without pinging back. Our own
   * posts never reach here, and the self-id check keeps that true even if the
   * filter above is relaxed. Commands are answered by notices, not by the
   * agent, and get no mention.
   *
   * The chain is also capped by `maxBotTurns` (see tripBotTurns): even with
   * mentionBackBots on, two agents cannot answer each other indefinitely.
   */
  function mentionBackTarget(event, text) {
    const isBot = typeof event.bot_id === 'string' && event.bot_id.length > 0
    if (isBot && config.mentionBackBots !== true && !(config.mentionBackBotIds ?? []).includes(event.user)) return undefined
    if (typeof event.user !== 'string' || event.user.length === 0) return undefined
    if (selfIds !== undefined && selfIds.has(event.user)) return undefined
    return isSelfMention(text) ? event.user : undefined
  }

  /**
   * The Slack thread a message belongs to: its parent for a reply, itself for
   * a top-level message. Replies and notices always post under this root —
   * Slack asks for the parent's ts, not a reply's.
   */
  function threadRootOf(event) {
    return typeof event.thread_ts === 'string' && event.thread_ts.length > 0 && event.thread_ts !== event.ts ? event.thread_ts : event.ts
  }

  /**
   * The conversation a message drives: the channel (sessionScope 'channel'),
   * or one thread of it (sessionScope 'thread': "channel:root ts").
   */
  function conversationOf(channel, rootTs) {
    return config.sessionScope === 'thread' ? channel + ':' + rootTs : channel
  }

  /**
   * Per-conversation bot guard state: how many app-driven turns have run
   * since the last human message, and the normalized texts that drove them.
   *
   * A turn count alone would cut a legitimate collaboration short after a
   * couple of progress reports, so repetition is the primary brake: identical
   * content is not progress. The turn count is a generous backstop. A human
   * message resets both.
   */
  const botGuards = new Map()

  /** Bound the bookkeeping on a host that sees many conversations. */
  const BOT_GUARDS_MAX = 1000

  /** How many recent normalized texts are compared for repetition. */
  const BOT_REPEAT_WINDOW = 8

  function resetBotGuard(conversation) {
    botGuards.delete(conversation)
  }

  /** Compare content, not the mention prefix or incidental whitespace. */
  function normalizeBotText(text) {
    return String(text ?? '')
      .replace(/<@!?[A-Za-z0-9_-]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
  }

  /**
   * Record one app message that is about to drive a turn.
   *
   * @returns {boolean} true when the bot must stay silent instead.
   */
  function tripBotGuard(conversation, text) {
    // HMR can reload this module before the plugin config is revalidated;
    // fall back to the documented defaults so a reload cannot silently
    // disable the guard in that window.
    const maxTurns = config.maxBotTurns ?? 10
    const maxRepeats = config.maxBotRepeats ?? 3
    if (maxTurns === 0 && maxRepeats === 0) return false
    const state = botGuards.get(conversation) ?? { turns: 0, recent: [] }
    const normalized = normalizeBotText(text)

    // Count repetitions before recording this occurrence: `repeat` is how
    // many times this exact text already drove a turn.
    const repeat = normalized === '' ? 0 : state.recent.filter((entry) => entry === normalized).length
    if (normalized !== '') {
      state.recent.push(normalized)
      if (state.recent.length > BOT_REPEAT_WINDOW) {
        state.recent.splice(0, state.recent.length - BOT_REPEAT_WINDOW)
      }
    }

    let reason
    if (maxRepeats > 0 && repeat >= maxRepeats) {
      reason = 'repeat'
    } else {
      state.turns += 1
      if (maxTurns > 0 && state.turns > maxTurns) reason = 'turns'
    }

    // Re-insert so the map's oldest key is the first eviction candidate.
    botGuards.delete(conversation)
    botGuards.set(conversation, state)
    while (botGuards.size > BOT_GUARDS_MAX) {
      const oldest = botGuards.keys().next().value
      if (oldest === undefined) break
      botGuards.delete(oldest)
    }

    if (reason === undefined) return false
    logger.warn(
      'bot loop guard: staying silent (' + reason + '; turns ' + state.turns + ', repeat ' + repeat + ') in ' + conversation,
    )
    return true
  }

  /**
   * Messages the agent has NOT seen, per channel, oldest first. With
   * mentionOnly on, a message that does not address the bot drives no turn —
   * but it is kept here and attached to the next turn that does, so the
   * agent still knows what the channel has been saying. A composition that
   * gates nothing buffers nothing, so this costs no memory by default.
   */
  const unseenByChannel = new Map()

  /** How many channels keep a buffer (memory bound). */
  const UNSEEN_CHANNELS_MAX = 50

  /** Per-message character cap inside a context block (prompt bound). */
  const UNSEEN_TEXT_MAX = 1500

  /** How one buffered message is attributed in the context block. */
  function speakerLabel(event) {
    if (typeof event.user === 'string' && event.user.length > 0) return '<@' + event.user + '>'
    if (typeof event.bot_id === 'string' && event.bot_id.length > 0) return 'app:' + event.bot_id
    return 'someone'
  }

  /** Remember one gated message as context, honouring both caps. */
  function rememberUnseen(channel, event, text) {
    if (config.contextMessages === 0) return
    const buffer = unseenByChannel.get(channel) ?? []
    const body = text.length > UNSEEN_TEXT_MAX ? text.slice(0, UNSEEN_TEXT_MAX) + '…' : text
    buffer.push({ ts: event.ts, who: speakerLabel(event), text: body })
    if (buffer.length > config.contextMessages) buffer.splice(0, buffer.length - config.contextMessages)
    // Re-insert so the map's order is least-recently-used last.
    unseenByChannel.delete(channel)
    unseenByChannel.set(channel, buffer)
    while (unseenByChannel.size > UNSEEN_CHANNELS_MAX) {
      const oldest = unseenByChannel.keys().next().value
      if (oldest === undefined) break
      unseenByChannel.delete(oldest)
    }
  }

  /**
   * The buffered messages for a turn that addresses the bot, consumed here so
   * each one is carried exactly once. Empty when there is nothing to add.
   */
  function takeUnseen(channel) {
    const buffer = unseenByChannel.get(channel)
    unseenByChannel.delete(channel)
    return buffer ?? []
  }

  /** The context block for taken unseen messages; undefined when there are none. */
  function unseenBlock(buffer) {
    if (buffer.length === 0) return undefined
    return [
      '[channel context — ' + buffer.length + ' message(s) posted since your last reply, oldest first]',
      ...buffer.map((message) => message.who + ': ' + message.text),
      '[end of channel context]',
    ].join('\n')
  }

  /**
   * Slack subtypes that are real posts and belong in a thread backfill; every
   * other subtype (joins, edits, deletes, …) is a trace.
   */
  const THREAD_CONTEXT_SUBTYPES = new Set([undefined, 'bot_message', 'thread_broadcast', 'file_share'])

  /** Time budget for one thread backfill, all pages included (event chain bound). */
  const THREAD_CONTEXT_TIMEOUT_MS = 10000

  /** Whether a fetched message is one of OUR earlier posts. */
  function isOwnPost(message) {
    if (selfIds === undefined) return false
    return (typeof message.bot_id === 'string' && selfIds.has(message.bot_id))
      || (typeof message.user === 'string' && selfIds.has(message.user))
  }

  /**
   * The thread-history block for the first turn of a session created for a
   * thread that already has messages (the thread began before sessionScope
   * 'thread', or after !new, or before a restart): the thread's messages
   * before the triggering one, newest `threadContextMessages` kept, minus
   * those the unseen block already carries. One line per message; the root
   * is marked [thread parent] and our own posts [assistant]. A failed fetch
   * (missing scope, network) is logged and the turn goes on without it.
   * @param skipTs - ts of the messages carried by the unseen block.
   */
  async function threadContext(channel, rootTs, triggerTs, skipTs) {
    if (config.threadContextMessages === 0) return undefined
    let messages
    try {
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(THREAD_CONTEXT_TIMEOUT_MS)])
      messages = await slack.replies(channel, rootTs, { latest: triggerTs, signal })
    } catch (error) {
      logger.warn('thread history for ' + channel + ':' + rootTs + ' unavailable, continuing without it: ' + errorText(error))
      return undefined
    }
    const entries = []
    for (const message of messages) {
      if (!THREAD_CONTEXT_SUBTYPES.has(message.subtype)) continue
      if (typeof message.ts !== 'string' || skipTs.has(message.ts)) continue
      if (Number(message.ts) >= Number(triggerTs)) continue
      const flat = (message.text ?? '').trim().replace(/\s*\n\s*/g, ' ⏎ ')
      if (flat.length === 0) continue
      const body = flat.length > UNSEEN_TEXT_MAX ? flat.slice(0, UNSEEN_TEXT_MAX) + '…' : flat
      const parent = message.ts === rootTs
      const line = (parent ? '[thread parent] ' : '') + (isOwnPost(message) ? '[assistant] ' + body : speakerLabel(message) + ': ' + body)
      entries.push({ parent, line })
    }
    if (entries.length === 0) return undefined
    // Newest messages win the cap, but the parent — what the thread is about
    // — keeps its place at the top.
    const kept = entries.slice(-config.threadContextMessages)
    if (entries[0].parent === true && kept[0] !== entries[0] && kept.length > 1) kept[0] = entries[0]
    return [
      '[Thread context — prior messages in this thread (not yet in conversation history):]',
      ...kept.map((entry) => entry.line),
      '[End of thread context]',
    ].join('\n')
  }

  /** Sender mentions followed by configured CC ids, redirected and de-duplicated. */
  function replyMentionPrefix(mentionUserIds = []) {
    const ids = []
    // HMR can reload this module before the plugin config is revalidated;
    // CC and redirect nobody in that window.
    const rewrites = config.mentionRewrites ?? {}
    for (const raw of [...mentionUserIds, ...(config.ccUserIds ?? [])]) {
      const id = rewrites[raw] ?? raw
      if (!ids.includes(id)) ids.push(id)
    }
    return ids.length > 0 ? ids.map((id) => '<@' + id + '>').join(' ') + ' ' : ''
  }

  /**
   * Deliver one channel reply, splitting to the configured size cap and
   * converting to mrkdwn. Threaded when threadReplies and the originating
   * message's ts is known. A failed post is logged and dropped: one lost
   * reply must never wedge the socket loop. When the triggering message
   * mentioned us, the FIRST chunk is prefixed with a mention of its author
   * plus any CC ids (after mrkdwn conversion, so the mentions are not escaped).
   */
  async function sendReply(record, text) {
    let first = true
    for (const raw of splitMessage(text, config.maxReplyChars)) {
      const converted = toSlackMrkdwn(raw, mrkdwnOptions)
      const alreadyMentioned = /^\s*<@!?[UW][A-Z0-9]+/.test(converted)
      const prefix = first === true && !alreadyMentioned ? replyMentionPrefix(record.mentionUserIds) : ''
      first = false
      const body = prefix + converted
      // Safety valve: escaping can grow a chunk past the intended cap.
      for (const piece of splitMessage(body, config.maxReplyChars + 64)) {
        try {
          await slack.postMessage(record.chatId, piece, {
            threadTs: config.threadReplies === true ? record.threadTs : undefined,
          })
        } catch (error) {
          logger.warn('postMessage to ' + record.chatId + ' failed: ' + errorText(error))
          return
        }
      }
    }
  }

  /**
   * Submit one prompt to the agent as a fresh follow-up turn.
   * @param ackTs - the messages it answers; their receipt reactions clear when it settles.
   * @param mentionUserIds - authors to mention back in the reply.
   */
  function startTurn(record, text, { ackTs = [], mentionUserIds = [], threadTs }) {
    record.busy = true
    record.threadTs = threadTs ?? ackTs.at(-1)
    record.ackTs = ackTs
    record.mentionUserIds = mentionUserIds
    /** When the turn started: a restart saves it as interrupted. */
    record.turnStartedAt = Date.now()
    record.collector ??= createTurnCollector()
    record.collector.clear()
    try {
      record.agent.followup(createTextUserMessage(text))
    } catch (error) {
      record.busy = false
      void sendReply(record, 'Could not queue the message: ' + errorText(error))
    }
  }

  // Turn gate: with maxConcurrentTurns set, at most that many channel turns
  // run at once across all conversations (2026-10-23: up to seven thread
  // sessions ran together and kept the NVIDIA account rate-limited). Waiting
  // messages stay in their conversation's queue; each carries an arrival
  // number so a freed slot goes to the oldest one, whichever thread it is in.
  // Running and waiting are read off the live records, so a session replaced
  // by !new or disposed mid-turn can never keep a slot.
  //
  // A conversation keeps at most ONE waiting entry (2026-10-24): every later
  // message for it joins that entry and is answered in the same turn. While
  // one ten-hour turn held the only slot, the other agents kept posting
  // progress checks and re-requests to the waiting threads; each became a
  // turn of its own and the queue grew from 6 to 39 messages. Joined, a
  // waiting thread costs one turn however often it is pinged.
  const turnLimit = config.maxConcurrentTurns ?? 0
  let arrivals = 0
  /** Set by teardown: no new turn starts once the snapshot is taken. */
  let closing = false

  /** Channel turns running now. */
  function runningTurns() {
    return sessions.all().filter((record) => record.busy === true).length
  }

  /** "N threads waiting in all" — conversations with a waiting entry. */
  function waitingLabel() {
    const count = sessions.all().filter((record) => record.queue.length > 0).length
    return count + (count === 1 ? ' thread' : ' threads') + ' waiting in all'
  }

  /**
   * Whether a message for an idle conversation must wait for a turn slot:
   * every slot is taken, or an older message already waits for one.
   */
  function mustWait() {
    if (turnLimit === 0) return false
    if (runningTurns() >= turnLimit) return true
    return sessions.all().some((record) => record.busy !== true && record.queue.length > 0)
  }

  /**
   * Hold messages until a slot (and the conversation) is free. The first
   * waiting message opens the conversation's entry and keeps its place in
   * line; later ones join it.
   * @param incoming - { parts: [{ who, text }], ackTs, mentionUserIds, threadTs }.
   * @returns whether this call opened the entry (false: it joined one).
   */
  function enqueue(record, incoming) {
    let entry = record.queue[0]
    const opened = entry === undefined
    if (opened) {
      entry = { parts: [], ackTs: [], mentionUserIds: [], threadTs: incoming.threadTs, arrival: ++arrivals }
      record.queue.push(entry)
    }
    for (const part of incoming.parts) {
      // Bots re-post the same request word for word; one copy is enough.
      if (!entry.parts.some((seen) => seen.who === part.who && seen.text === part.text)) entry.parts.push(part)
    }
    for (const ts of incoming.ackTs ?? []) if (!entry.ackTs.includes(ts)) entry.ackTs.push(ts)
    for (const id of incoming.mentionUserIds ?? []) if (!entry.mentionUserIds.includes(id)) entry.mentionUserIds.push(id)
    return opened
  }

  /** One waiting entry as a prompt: a lone message as posted, several as one labelled block. */
  function entryPrompt(entry) {
    if (entry.parts.length === 1) return entry.parts[0].text
    const count = entry.parts.length
    return [
      '[' + count + ' messages reached this thread while it waited for a turn, oldest first. Answer them together in one reply: later ones may repeat, update or replace earlier ones.]',
      ...entry.parts.map((part, index) => '--- message ' + (index + 1) + ' of ' + count + ' (' + part.who + ') ---\n' + part.text),
      '[end of waiting messages]',
    ].join('\n\n')
  }

  /** Start queued entries while slots are free: oldest arrival first, one turn per conversation. */
  function pump() {
    for (;;) {
      if (closing) return
      if (turnLimit !== 0 && runningTurns() >= turnLimit) return
      let next
      for (const record of sessions.all()) {
        if (record.busy === true || record.queue.length === 0) continue
        if (next === undefined || record.queue[0].arrival < next.queue[0].arrival) next = record
      }
      if (next === undefined) return
      const entry = next.queue.shift()
      startTurn(next, entryPrompt(entry), entry)
    }
  }

  /**
   * The note that resumes a turn a restart caught running (the session still
   * holds its work). Worded for both outcomes: an owned session's turn is
   * stopped by the restart, a joined one (held by the host) runs on.
   */
  function interruptedNote(startedAt, stoppedAt) {
    const since = startedAt === undefined ? '' : ' (running since ' + new Date(startedAt).toISOString() + ')'
    return '[Channel note: the Slack channel restarted at ' + stoppedAt + ' while your turn in this thread was running' + since
      + ', so nothing from that turn reached Slack. If it was stopped, check where that work stands and finish it; then reply with the result.]'
  }

  /** Running turns (as interrupted) and waiting entries, in the order the next mount should queue them. */
  function pendingSnapshot() {
    const stoppedAt = new Date().toISOString()
    const running = []
    const waiting = []
    for (const record of sessions.all()) {
      const where = { key: record.key, channel: record.chatId }
      if (record.busy === true) {
        running.push({
          ...where,
          order: record.turnStartedAt ?? 0,
          threadTs: record.threadTs,
          ackTs: record.ackTs ?? [],
          mentionUserIds: record.mentionUserIds ?? [],
          parts: [{ who: 'channel', text: interruptedNote(record.turnStartedAt, stoppedAt) }],
          interrupted: true,
        })
      }
      for (const entry of record.queue) {
        waiting.push({ ...where, order: entry.arrival, threadTs: entry.threadTs, ackTs: entry.ackTs, mentionUserIds: entry.mentionUserIds, parts: entry.parts })
      }
    }
    running.sort((a, b) => a.order - b.order)
    waiting.sort((a, b) => a.order - b.order)
    return [...running, ...waiting].map(({ order, ...entry }) => entry)
  }

  /** Queue the entries a previous mount saved, then start what fits (runs first on the event chain). */
  async function restorePending(saved) {
    const interrupted = []
    for (const entry of saved) {
      let record
      try {
        record = await sessions.get(entry.key, { channel: entry.channel })
      } catch (error) {
        logger.warn('could not restore the waiting messages of ' + entry.key + ': ' + errorText(error))
        void sendReplyText(entry.channel, entry.threadTs, 'A channel restart lost ' + Math.max(entry.ackTs.length, 1) + ' waiting message(s) here: this thread\'s session is open in another DSH process. Post again once it is closed there. (' + errorText(error) + ')')
        continue
      }
      record.collector ??= createTurnCollector()
      // The saved prompt already carries any thread history a fresh session needs.
      record.fresh = false
      enqueue(record, entry)
      if (entry.interrupted === true && !interrupted.includes(record)) interrupted.push(record)
    }
    logger.info('restored ' + saved.length + ' waiting entr(ies) after a restart')
    pump()
    for (const record of interrupted) {
      if (record.busy === true || record.queue.length === 0) continue
      void sendReplyText(record.chatId, record.queue[0].threadTs, 'Queued: the turn running here was stopped by a channel restart; it resumes when a turn slot is free (' + waitingLabel() + ').')
    }
  }

  /** One turn ended: reduce collected texts to a reply and release the channel. */
  async function settleTurn(record, turn, reason) {
    const kind = reason?.kind
    const reply = record.collector.take(turn, config.replyMode)
    let text
    if (kind === 'aborted') {
      text = 'Stopped.'
    } else if (kind === 'error') {
      text = 'Turn failed' + (record.lastError === undefined ? '.' : ': ' + record.lastError)
    } else if (reply !== undefined) {
      text = kind === 'max-tokens' ? reply + '\n\n(stopped at the output cap)' : reply
    }
    record.lastError = undefined
    if (text !== undefined) await sendReply(record, text)
    if (config.ackReaction !== '') {
      for (const ts of record.ackTs ?? []) void slack.unreact(record.chatId, ts, config.ackReaction)
    }
    record.ackTs = []
    record.mentionUserIds = []
    record.busy = false
    pump()
  }

  // Resolve this bot's own identity once, so the event filter can drop only
  // OUR messages and let other apps' posts through. Until it resolves every
  // bot message is dropped — the pre-existing strict behaviour — so a failed
  // probe can never let the agent answer itself.
  const identityProbe = (async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        const me = await slack.authTest(abort.signal)
        const ids = [me.bot_id, me.user_id].filter((id) => typeof id === 'string' && id.length > 0)
        // An answer without ids would yield an EMPTY identity set, which would
        // let every bot message through — including our own echoes. Treat it
        // as a failure so the strict filter stays in force.
        if (ids.length === 0) throw new Error('auth.test returned neither bot_id nor user_id')
        selfIds = new Set(ids)
        selfUserId = typeof me.user_id === 'string' && me.user_id.length > 0 ? me.user_id : undefined
        logger.info('own identity resolved (bot_id=' + me.bot_id + ', user_id=' + me.user_id + '); messages from other apps are accepted')
        return
      } catch (error) {
        if (abort.signal.aborted) return
        if (attempt >= 5) {
          logger.warn('auth.test failed, keeping the strict bot-message filter: ' + errorText(error))
          return
        }
        await sleep(attempt * 1000, abort.signal)
      }
    }
  })()

  // Reply path: committed assistant text of owned, busy sessions accumulates
  // per turn; the matching turn/end settles and releases the channel. Raw
  // chunks, reasoning, tool traffic, and titles stay off the wire.
  const offEvent = ctx.on('session/event', (session, event) => {
    const record = sessions.lookup(session.header.id)
    if (record === undefined || record.agent.session !== session || record.busy !== true) return
    if (event.type === 'assistant/message') {
      for (const block of event.data?.message?.content ?? []) {
        if (block.type === 'text') record.collector.add(event.data.turn, block.text)
      }
    } else if (event.type === 'turn/end') {
      settleTurn(record, event.data.turn, event.data.reason).catch((error) => {
        logger.warn('reply settlement failed: ' + errorText(error))
        record.busy = false
        pump()
      })
    }
  })

  // Failure path: remember the machine error so the error turn's reply can
  // quote it; the turn/end event still settles the channel.
  const offError = ctx.on('agent/error', (payload) => {
    const record = sessions.lookup(payload.agent?.session?.id)
    if (record === undefined || record.agent !== payload.agent) return
    record.lastError = errorText(payload.error)
  })

  // Interactive-prompt path: a channel session has no GUI of its own, so an
  // approval or an ask_user_question request used to wait on a DSH client that
  // may never answer — the turn, and with it the channel, stayed blocked (every
  // later message queued) until the host restarted. These listeners are
  // PREPENDED so an owned agent's prompt always reaches Slack, while the rest
  // of the waterfall stays live: interactions.js races the other answerers and
  // settles at the configured deadline, so nothing can wedge the channel.
  // Foreign agents (subagents, web sessions) are delegated untouched inside.
  const offApproval = ctx.on('approval/request', (request, next) => interactions.answerApproval(request, next), { prepend: true })
  const offQuestions = ctx.on('user-questions/request', (request, next) => interactions.answerQuestion(request, next), { prepend: true })
  // An approval request carries the call id but not the arguments, so the
  // prompt learns the command here, on the way in. Prepended so no listener
  // that answers the gate itself (an `ask`, a deny) can skip past it.
  const offCalls = ctx.on('tools/pre-execute', (exec, next) => {
    interactions.noteCall(exec)
    return next()
  }, { prepend: true })

  /**
   * Handle one Slack message event. Only `message` events are accepted —
   * the manifest should not subscribe `app_mention` (Slack would deliver
   * both and double-drive the agent). Messages from OTHER apps are processed
   * (they carry their own bot_id); OUR OWN messages — bot_id, or the bot
   * user id for app-user posts — and edit/delete/join traces are skipped so
   * the agent never reacts to itself. Until auth.test resolves our ids every
   * bot message is skipped, the strict fallback.
   */
  async function handleEvent(event) {
    if (event?.type !== 'message') return
    // `bot_message` is how another app posts; any other subtype is a trace
    // (message_changed, message_deleted, channel_join, thread_broadcast, …)
    // and must not drive the agent.
    if (event.subtype !== undefined && event.subtype !== 'bot_message') return
    // Our own posts come back as events; skipping exactly those is what keeps
    // the agent from answering itself.
    if (event.bot_id !== undefined && (selfIds === undefined || selfIds.has(event.bot_id))) return
    if (event.user !== undefined && selfIds !== undefined && selfIds.has(event.user)) return
    const channel = event.channel
    if (channel === undefined) return
    const text = (event.text ?? '').trim()
    if (text.length === 0) return
    const command = asCommand(text)
    const rootTs = threadRootOf(event)
    const conversation = conversationOf(channel, rootTs)
    const inThread = rootTs !== event.ts
    const isAppMessage = typeof event.bot_id === 'string' && event.bot_id.length > 0

    // Pairing is the one command an unauthorized channel may use: an
    // operator secret enrolls the channel without a host restart. A wrong
    // token falls through to the gate — no token-guessing oracle beyond
    // Slack's own rate limits. asCommand returns the whole remainder, so the
    // verb is matched as the first token: `/pair <secret>` must reach here.
    if (config.pairToken !== undefined && command !== undefined && /^pair(\s|$)/.test(command)) {
      if (text.slice(5).trim() === config.pairToken) {
        sessions.enroll(channel)
        return sendReplyText(channel, rootTs, 'Paired — this channel is now authorized.')
      }
    }

    if (!authorized(channel)) {
      if (!warnedChannels.has(channel)) {
        warnedChannels.add(channel)
        logger.warn('rejected message from unauthorized channel ' + channel + ' (add it to allowedChannelIds or set allowAllChannels: true)')
      }
      if (config.notifyUnauthorized === true) {
        void slack.postMessage(channel, 'This bot is not authorized for this channel.')
      }
      return
    }

    // A human message makes the conversation human again: give a bot chain
    // that was close to the cap a fresh budget. Commands count too.
    if (isAppMessage === false) resetBotGuard(conversation)

    if (command === 'start' || command === 'help') return sendReplyText(channel, rootTs, HELP_TEXT)
    if (command === 'id' || command === 'channelid') return sendReplyText(channel, rootTs, channel)
    if (command === 'new') {
      // Under sessionScope 'thread' every top-level message already opens its
      // own session; !new resets the thread it is posted in.
      if (config.sessionScope === 'thread' && inThread === false) {
        return sendReplyText(channel, rootTs, 'Every new thread already starts its own session — post !new inside a thread to reset that thread.')
      }
      await sessions.get(conversation, { fresh: true, channel })
      // The replaced session may have held a turn slot.
      pump()
      return sendReplyText(channel, rootTs, config.sessionScope === 'thread' ? 'Started a fresh session for this thread.' : 'Started a fresh session.')
    }
    if (command === 'stop') {
      const record = sessions.record(conversation)
      if (record !== undefined && record.busy !== true && record.queue.length > 0) {
        // Nothing runs here, but messages wait for a turn slot: drop them.
        const dropped = Math.max(record.queue[0].ackTs.length, 1)
        record.queue.length = 0
        return sendReplyText(channel, rootTs, 'Cleared ' + dropped + ' waiting message' + (dropped === 1 ? '' : 's') + '.')
      }
      if (record === undefined || record.busy !== true) return sendReplyText(channel, rootTs, 'Nothing is running.')
      record.queue.length = 0
      record.collector?.clear()
      record.agent.cancel({ kind: 'user' })
      return sendReplyText(channel, rootTs, 'Stop requested.')
    }

    // Interactive prompts are answered by the buttons on the prompt message;
    // these commands are the text equivalents (`!answer` is also the free-form
    // "Other" path for a question that has buttons). Both report when nothing
    // is waiting, so a typo is not silently swallowed.
    const verb = command === undefined ? undefined : command.split(/\s+/)[0]
    if (verb === 'allow' || verb === 'deny') {
      if (interactions.answerFromText(conversation, verb, '', event.user) === true) return
      return sendReplyText(channel, rootTs, 'Nothing is waiting for approval.')
    }
    if (verb === 'answer') {
      const body = command.slice(verb.length).trim()
      if (body.length === 0) return sendReplyText(channel, rootTs, 'Usage: !answer <text>')
      if (interactions.answerFromText(conversation, verb, body, event.user) === true) return
      return sendReplyText(channel, rootTs, 'Nothing is waiting for an answer.')
    }
    // A plain message answers an option-less question prompt: there is nothing
    // to click for one, and the turn is blocked on it anyway. Every other
    // message keeps its ordinary meaning (gating below, then a turn or queue).
    if (command === undefined && interactions.answerFromText(conversation, undefined, text, event.user) === true) return

    // Mention gating: with mentionOnly on, a channel message that does not
    // address the bot drives no turn — it is remembered instead, to be handed
    // to the next message that does. DMs are always addressed to the bot and
    // are never gated (a DM that required a mention would be unusable).
    // Unseen messages are kept where the next addressed turn will read them:
    // per thread for thread replies under sessionScope 'thread', per channel
    // otherwise (a top-level mention opens a new thread and reads the channel).
    const unseenKey = config.sessionScope === 'thread' && inThread ? conversation : channel
    if (config.mentionOnly === true && isSelfMention(text) === false && channel.startsWith('D') === false) {
      rememberUnseen(unseenKey, event, text)
      return
    }

    // This message would drive a turn. If it is the (maxBotTurns + 1)th app
    // message in a row, drop it without a reply: answering is what would keep
    // the other agent's turn alive.
    if (isAppMessage && tripBotGuard(conversation, text)) return

    let record
    try {
      record = await sessions.get(conversation, { channel })
    } catch (error) {
      // Most notably the single-owner rule: the mapped session is held by
      // another DSH process (a session live in this one is joined instead).
      // Say so instead of forking a fresh session behind the user's back.
      return sendReplyText(channel, rootTs, 'This thread\'s session is open in another DSH process — close it there, then post here again. (' + errorText(error) + ')')
    }
    record.collector ??= createTurnCollector()

    // The "working" indicator: react on receipt, unreact when the reply
    // for THIS message's turn is delivered.
    if (config.ackReaction !== '' && event.ts !== undefined) {
      void slack.react(channel, event.ts, config.ackReaction)
    }

    // A session created for a reply in an existing thread has none of the
    // thread's earlier messages: its first turn opens with them (Hermes-style
    // backfill). Only that first turn — the session remembers from then on.
    const backfill = record.fresh === true && inThread && config.sessionScope === 'thread'
    record.fresh = false

    // A mention-driven turn opens with the messages the agent has not seen,
    // so answering "what do you think?" still knows what was discussed.
    const unseen = isSelfMention(text) ? takeUnseen(unseenKey) : []
    const history = backfill ? await threadContext(channel, rootTs, event.ts, new Set(unseen.map((message) => message.ts))) : undefined
    const prompt = [history, unseenBlock(unseen), text].filter((part) => part !== undefined).join('\n\n')

    const target = mentionBackTarget(event, text)
    const incoming = { parts: [{ who: speakerLabel(event), text: prompt }], ackTs: [event.ts], mentionUserIds: target === undefined ? [] : [target], threadTs: rootTs }
    // Only the message that opens a waiting entry is acknowledged in words;
    // one that joins it gets the receipt reaction alone. The ack says so,
    // because the agents that kept re-asking read a fresh "Queued" as a cue
    // to ask again.
    const joinNote = ' Later messages here join this request and are answered in the same turn — no need to post again.'
    if (record.busy) {
      const opened = enqueue(record, incoming)
      // A queue behind a prompt is not the agent thinking: say what it waits
      // for, so a silent channel is never mistaken for a wedged one.
      const prompting = interactions.hasPending(conversation)
      if (config.ackQueued === false || (opened === false && prompting === false)) return
      return sendReplyText(channel, rootTs, 'Queued: this thread\'s turn is still running.' + (prompting ? ' Answer the prompt above to continue.' : '') + joinNote)
    }
    if (mustWait()) {
      const opened = enqueue(record, incoming)
      if (config.ackQueued === false || opened === false) return
      return sendReplyText(channel, rootTs, 'Queued: another conversation\'s turn is running (' + waitingLabel() + ').' + joinNote)
    }
    startTurn(record, prompt, incoming)
  }

  /** Post a control/notice message (commands, acks) into a thread. */
  async function sendReplyText(channel, ts, text) {
    for (const raw of splitMessage(text, config.maxReplyChars)) {
      const body = replyMentionPrefix(undefined) + toSlackMrkdwn(raw, mrkdwnOptions)
      try {
        await slack.postMessage(channel, body, {
          threadTs: config.threadReplies === true ? ts : undefined,
        })
      } catch (error) {
        logger.warn('postMessage to ' + channel + ' failed: ' + errorText(error))
        return
      }
    }
  }

  // Socket Mode loop: reconnects with fresh single-use URLs until teardown
  // aborts it; every events_api envelope is acked and routed to handleEvent.
  // Events are processed STRICTLY IN ORDER through a promise chain — the
  // loop must never run two handleEvent passes concurrently (a /new racing
  // the previous message's session creation would orphan sessions), exactly
  // like the Telegram sibling's sequential poll loop.
  // What a previous mount saved is read now, synchronously: dsh-hmr disposes
  // the old instance (which saves first thing) before it mounts this one.
  // Queuing it again opens the event chain, ahead of every new message, once
  // our identity is known (the plugin is up; sessions are created after it).
  const restored = takePending(pendingPath, logger)
  /** Saved entries and Slack payloads not yet handled (none left = the drain status is final). */
  let unhandled = restored.length === 0 ? 0 : 1
  let eventChain = restored.length === 0
    ? Promise.resolve()
    : identityProbe.then(() => restorePending(restored)).catch((error) => logger.warn('restoring waiting messages failed: ' + errorText(error))).finally(() => { unhandled -= 1 })
  // The socket runs while receiving; the receive-off file closes it (and its
  // removal opens it again) without a reload, so nothing running here stops.
  let socketAbort
  let socketLoop = Promise.resolve()
  function startSocket() {
    if (socketAbort !== undefined || closing) return
    socketAbort = new AbortController()
    socketLoop = runSocketLoop({
      slack,
      onEvent: (event) => {
        unhandled += 1
        eventChain = eventChain
          .then(() => handleEvent(event))
          .catch((error) => logger.warn('event handling failed: ' + errorText(error)))
          .finally(() => { unhandled -= 1 })
      },
      // Button clicks ride the same chain as events: a click that answers a
      // prompt and rewrites its message stays ordered against the posts around
      // it, and a slow handler can never interleave two Slack writes.
      onInteractive: (payload) => {
        unhandled += 1
        eventChain = eventChain
          .then(() => interactions.handleInteractive(payload))
          .catch((error) => logger.warn('interaction handling failed: ' + errorText(error)))
          .finally(() => { unhandled -= 1 })
        return eventChain
      },
      signal: AbortSignal.any([abort.signal, socketAbort.signal]),
      logger,
      retryDelayMs: config.socketRetryDelayMs,
      wsFactory: config.wsFactory,
    })
    socketLoop.catch((error) => logger.error('socket loop crashed: ' + errorText(error)))
  }
  function stopSocket() {
    socketAbort?.abort()
    socketAbort = undefined
  }

  let drainState = ''
  /** Follow the receive-off file; while it is there, say what still runs or waits here. */
  function checkReceive() {
    if (closing) return
    const off = receiveIsOff(receiveOffPath)
    if (off && receiving) {
      receiving = false
      stopSocket()
      logger.info('receive off (' + receiveOffPath + '): Slack socket closed; running turns and waiting messages finish here, new messages go to the other host')
    } else if (!off && !receiving) {
      receiving = true
      drainState = ''
      clearDrain(drainPath)
      startSocket()
      logger.info('receive on again: ' + receiveOffPath + ' is gone, Slack socket opening')
    }
    if (receiving) return
    const running = sessions.all().filter((record) => record.busy === true).map((record) => record.key ?? String(record.chatId))
    const waiting = sessions.all().filter((record) => record.queue.length > 0).map((record) => record.key ?? String(record.chatId))
    const drained = running.length === 0 && waiting.length === 0 && unhandled === 0
    const state = JSON.stringify({ running, waiting, drained })
    if (state === drainState) return
    if (drained) logger.info('receive off: nothing runs or waits here any more — this host can be stopped')
    drainState = state
    writeDrain(drainPath, { receiving: false, drained, running, waiting, updatedAt: new Date().toISOString() }, logger)
  }

  if (receiving) startSocket()
  else logger.info('receive off at mount (' + receiveOffPath + '): no Slack socket; what was saved still runs here')
  const receiveTimer = receiveOffPath === undefined ? undefined : setInterval(checkReceive, config.receivePollMs)
  receiveTimer?.unref?.()
  if (!receiving) checkReceive()

  ctx.effect(() => teardown, 'slack-channel')

  /** Full teardown: stop the socket loop, unsubscribe, dispose sessions. */
  async function teardown() {
    // Saved before anything else and synchronously: the next mount reads the
    // file as soon as this disposal is done. No turn starts after this point.
    closing = true
    savePending(pendingPath, pendingSnapshot(), logger)
    clearInterval(receiveTimer)
    abort.abort()
    try {
      await socketLoop
    } catch { /* already reported */ }
    try {
      await eventChain
    } catch { /* already reported */ }
    try {
      await identityProbe
    } catch { /* already reported */ }
    if (typeof offEvent === 'function') offEvent()
    if (typeof offError === 'function') offError()
    if (typeof offApproval === 'function') offApproval()
    if (typeof offQuestions === 'function') offQuestions()
    if (typeof offCalls === 'function') offCalls()
    // Settle every prompt still waiting: the sessions are about to go, and a
    // prompt that outlived them would hold the approval/question call forever.
    interactions.disposeAll()
    await sessions.disposeAll()
  }
}
