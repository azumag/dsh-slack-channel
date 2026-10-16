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
  const sessions = createChatSessions({ ctx, config, logger })
  const warnedChannels = new Set()
  const abort = new AbortController()

  // Handed to every formatter call: model output is escaped wholesale, so the
  // ids in config.mentionUserIds are the only ones that survive as real Slack
  // mentions (see format.js). An empty allowlist keeps them all as text.
  const mrkdwnOptions = { mentionUserIds: config.mentionUserIds }

  // Interactive prompts (permission approvals and ask_user_question) for the
  // sessions this plugin owns are answered from Slack — see interactions.js.
  // `authorized` is hoisted, so the manager can capture it here.
  const interactions = createInteractions({ config, logger, slack, sessions, authorized, mrkdwnOptions })

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
   * Anyone who mentions us is mentioned back — humans and other apps alike
   * (an app's message carries its own bot_id AND its user id, which is the
   * spelling a mention needs). Our own posts never reach here, and the
   * self-id check keeps that true even if the filter above is relaxed.
   * Commands are answered by notices, not by the agent, and get no mention.
   *
   * NOTE: two agents that mention each other can keep answering each other.
   * A channel where every participant replies to every message already had
   * that shape; the mention only makes the ping explicit. Add a rule here
   * (cooldown, channel allowlist, first-reply-only) if that ever runs hot.
   */
  function mentionBackTarget(event, text) {
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
    buffer.push({ who: speakerLabel(event), text: body })
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
   * The context block for a turn that addresses the bot — the buffered
   * messages, consumed here so each one is carried exactly once. Undefined
   * when there is nothing to add.
   */
  function takeUnseenContext(channel) {
    const buffer = unseenByChannel.get(channel)
    unseenByChannel.delete(channel)
    if (buffer === undefined || buffer.length === 0) return undefined
    return [
      '[channel context — ' + buffer.length + ' message(s) posted since your last reply, oldest first]',
      ...buffer.map((message) => message.who + ': ' + message.text),
      '[end of channel context]',
    ].join('\n')
  }

  /**
   * Deliver one channel reply, splitting to the configured size cap and
   * converting to mrkdwn. Threaded when threadReplies and the originating
   * message's ts is known. A failed post is logged and dropped: one lost
   * reply must never wedge the socket loop. When the triggering message
   * mentioned us, the FIRST chunk is prefixed with a mention of its author
   * (after mrkdwn conversion, so the mention is not escaped as text).
   */
  async function sendReply(record, text) {
    let first = true
    for (const raw of splitMessage(text, config.maxReplyChars)) {
      const prefix = first === true && record.mentionUserId !== undefined ? '<@' + record.mentionUserId + '> ' : ''
      first = false
      const body = prefix + toSlackMrkdwn(raw, mrkdwnOptions)
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

  /** Submit one channel message to the agent as a fresh follow-up turn. */
  function startTurn(record, text, eventTs, mentionUserId, threadTs) {
    record.busy = true
    record.threadTs = threadTs ?? eventTs
    record.eventTs = eventTs
    /** The author to mention back in this turn's reply, when they used one. */
    record.mentionUserId = mentionUserId
    record.collector ??= createTurnCollector()
    record.collector.clear()
    try {
      record.agent.followup(createTextUserMessage(text))
    } catch (error) {
      record.busy = false
      void sendReply(record, 'Could not queue the message: ' + errorText(error))
    }
  }

  /** Send the next queued message, if the channel agent is free again. */
  async function drain(record) {
    if (record.busy || record.queue.length === 0) return
    const next = record.queue.shift()
    startTurn(record, next.text, next.ts, next.mentionUserId, next.threadTs)
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
    if (config.ackReaction !== '' && record.eventTs !== undefined) {
      void slack.unreact(record.chatId, record.eventTs, config.ackReaction)
    }
    record.eventTs = undefined
    record.mentionUserId = undefined
    record.busy = false
    await drain(record)
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

    if (command === 'start' || command === 'help') return sendReplyText(channel, rootTs, HELP_TEXT)
    if (command === 'id' || command === 'channelid') return sendReplyText(channel, rootTs, channel)
    if (command === 'new') {
      // Under sessionScope 'thread' every top-level message already opens its
      // own session; !new resets the thread it is posted in.
      if (config.sessionScope === 'thread' && inThread === false) {
        return sendReplyText(channel, rootTs, 'Every new thread already starts its own session — post !new inside a thread to reset that thread.')
      }
      await sessions.get(conversation, { fresh: true, channel })
      return sendReplyText(channel, rootTs, config.sessionScope === 'thread' ? 'Started a fresh session for this thread.' : 'Started a fresh session.')
    }
    if (command === 'stop') {
      const record = sessions.record(conversation)
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

    let record
    try {
      record = await sessions.get(conversation, { channel })
    } catch (error) {
      // Most notably the single-owner rule: the mapped session is currently
      // open in another surface (the web UI). Say so instead of forking a
      // fresh session behind the user's back.
      return sendReplyText(channel, rootTs, 'This session is currently open in the DSH web interface — close or leave it there, then post here again. (' + errorText(error) + ')')
    }
    record.collector ??= createTurnCollector()

    // The "working" indicator: react on receipt, unreact when the reply
    // for THIS message's turn is delivered.
    if (config.ackReaction !== '' && event.ts !== undefined) {
      void slack.react(channel, event.ts, config.ackReaction)
    }

    // A mention-driven turn opens with the messages the agent has not seen,
    // so answering "what do you think?" still knows what was discussed.
    const unseen = isSelfMention(text) ? takeUnseenContext(unseenKey) : undefined
    const prompt = unseen === undefined ? text : unseen + '\n\n' + text

    if (record.busy) {
      record.queue.push({ text: prompt, ts: event.ts, threadTs: rootTs, mentionUserId: mentionBackTarget(event, text) })
      if (config.ackQueued === false) return
      // A queue behind a prompt is not the agent thinking: say what it waits
      // for, so a silent channel is never mistaken for a wedged one.
      const waiting = interactions.hasPending(conversation) ? ' Answer the prompt above to continue.' : ''
      return sendReplyText(channel, rootTs, 'Queued (' + record.queue.length + ' pending).' + waiting)
    }
    startTurn(record, prompt, event.ts, mentionBackTarget(event, text), rootTs)
  }

  /** Post a control/notice message (commands, acks) into a thread. */
  async function sendReplyText(channel, ts, text) {
    for (const raw of splitMessage(text, config.maxReplyChars)) {
      const body = toSlackMrkdwn(raw, mrkdwnOptions)
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
  let eventChain = Promise.resolve()
  const socketLoop = runSocketLoop({
    slack,
    onEvent: (event) => {
      eventChain = eventChain
        .then(() => handleEvent(event))
        .catch((error) => logger.warn('event handling failed: ' + errorText(error)))
    },
    // Button clicks ride the same chain as events: a click that answers a
    // prompt and rewrites its message stays ordered against the posts around
    // it, and a slow handler can never interleave two Slack writes.
    onInteractive: (payload) => {
      eventChain = eventChain
        .then(() => interactions.handleInteractive(payload))
        .catch((error) => logger.warn('interaction handling failed: ' + errorText(error)))
      return eventChain
    },
    signal: abort.signal,
    logger,
    retryDelayMs: config.socketRetryDelayMs,
    wsFactory: config.wsFactory,
  })
  socketLoop.catch((error) => logger.error('socket loop crashed: ' + errorText(error)))

  ctx.effect(() => teardown, 'slack-channel')

  /** Full teardown: stop the socket loop, unsubscribe, dispose sessions. */
  async function teardown() {
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
    // Settle every prompt still waiting: the sessions are about to go, and a
    // prompt that outlived them would hold the approval/question call forever.
    interactions.disposeAll()
    await sessions.disposeAll()
  }
}
