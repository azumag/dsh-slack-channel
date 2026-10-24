// Slack-side answering for the interactive seams a channel session can block
// on: permission approvals (`approval/request`, ctx.approval) and structured
// questions (`user-questions/request`, the ask_user_question tool).
//
// A channel session has no GUI of its own. Before this module existed the
// prompt only reached a DSH client that had the session open, so an unanswered
// dialog held the turn — and with it the channel's busy flag — until the host
// restarted; every later Slack message queued behind it and the channel went
// silent. Here the prompt becomes a Block Kit message in the channel: the
// buttons answer it, `!allow` / `!deny` / `!answer …` are the text fallbacks,
// the other answerers of the composition keep their chance (they are raced,
// not bypassed), and a deadline settles whatever nobody answered so the
// channel always comes back. Approvals fail closed at that deadline; a
// question reports the timeout to the model.

import { randomUUID } from 'node:crypto'
import { toSlackMrkdwn } from './format.js'

/**
 * Button action ids; handleInteractive routes on these strings. Slack refuses
 * a message whose actions block repeats an action_id, so option buttons carry
 * their index (`dsh-slack-option-2`) and are routed by prefix.
 */
export const ACTION_APPROVAL_ALLOW = 'dsh-slack-allow'
export const ACTION_APPROVAL_DENY = 'dsh-slack-deny'
export const ACTION_QUESTION_OPTION = 'dsh-slack-option'
export const ACTION_QUESTION_SUBMIT = 'dsh-slack-submit'

/** The action id of one option button. */
export function questionOptionActionId(optionIndex) {
  return ACTION_QUESTION_OPTION + '-' + optionIndex
}

/** Whether an action id belongs to an option button (bare id kept for old prompts). */
export function isQuestionOptionAction(actionId) {
  return actionId === ACTION_QUESTION_OPTION || (typeof actionId === 'string' && actionId.startsWith(ACTION_QUESTION_OPTION + '-'))
}

/** Slack caps: blocks per message, elements per actions block, field lengths. */
const BLOCKS_MAX = 50
const BUTTONS_PER_ROW = 5
const SECTION_TEXT_MAX = 2900
const BUTTON_LABEL_MAX = 75
/** Slack may cut button text at about this many characters. */
const BUTTON_LABEL_VISIBLE = 30
const REASON_MAX = 1500
const DETAIL_MAX = 800
const OPTION_DESCRIPTION_MAX = 300
const FALLBACK_TEXT_MAX = 400

/** A promise that never settles, for "this racer has nothing to say yet". */
const NEVER = new Promise(() => {})

/** A Slack user id that is safe to write as a raw mention (never model text). */
const SLACK_USER_ID = /^[UW][A-Za-z0-9_-]+$/

function text(value) {
  return typeof value === 'string' ? value : ''
}

/** Cut a string to a Slack field cap, marking the cut. */
function clip(value, max) {
  const body = text(value)
  return body.length <= max ? body : body.slice(0, Math.max(0, max - 1)) + '…'
}

/** Backticks inside a code span would end it early; the tool name is ours. */
function codeSpan(value) {
  return '`' + text(value).replace(/`/g, "'") + '`'
}

/** Render a duration the way a prompt reads it (30m, 45s, 1.5m). */
export function humanDuration(ms) {
  if (!(ms > 0)) return 'never'
  if (ms % 60000 === 0) return ms / 60000 + 'm'
  if (ms % 1000 === 0) return ms / 1000 + 's'
  return Math.round(ms / 100) / 10 + 's'
}

/**
 * Build the Slack-side interaction manager.
 * @param options.config - validated plugin config (interactiveTimeoutMs, threadReplies).
 * @param options.logger - named plugin logger.
 * @param options.slack - SlackClient (postMessage / updateMessage).
 * @param options.sessions - the chat-session manager (lookup by session id).
 * @param options.authorized - (channelId) => boolean, the same channel gate handleEvent uses.
 * @param options.mrkdwnOptions - formatter options (the mention allowlist).
 */
export function createInteractions({ config, logger, slack, sessions, authorized, mrkdwnOptions, receiving = () => true }) {
  /** id → entry, for button clicks. */
  const pending = new Map()
  /**
   * Session scope → insertion-ordered ids, for text answers and lookups. The
   * scope is the record's key: the channel id (sessionScope: channel) or
   * "channel:thread root ts" (sessionScope: thread), so a prompt is answered
   * from the conversation that owns it.
   */
  const byChannel = new Map()
  /** The configured deadline; 0 waits forever (only !stop ends a prompt). */
  const timeoutMs = config.interactiveTimeoutMs

  function errorText(error) {
    return error?.message ?? String(error)
  }

  /**
   * The channel record a request belongs to: the agent itself, or the live
   * root it was delegated from. A subagent's approval would otherwise wait on
   * a UI that has no idea this channel exists — the same wedge, one level
   * down. A session that is not ours (a web session, a foreign agent) yields
   * undefined, so the request is delegated untouched.
   */
  function ownedRecord(agent) {
    for (let cursor = agent; cursor !== undefined; cursor = cursor.parentAgent) {
      const sessionId = cursor?.session?.id
      if (typeof sessionId !== 'string') return undefined
      const record = sessions.lookup(sessionId)
      if (record === undefined) continue
      return record.agent === cursor ? record : undefined
    }
    return undefined
  }

  function threadOf(record) {
    return config.threadReplies === true ? record.threadTs : undefined
  }

  function track(entry) {
    pending.set(entry.id, entry)
    let ids = byChannel.get(entry.scope)
    if (ids === undefined) {
      ids = new Set()
      byChannel.set(entry.scope, ids)
    }
    ids.add(entry.id)
  }

  function untrack(entry) {
    pending.delete(entry.id)
    const ids = byChannel.get(entry.scope)
    if (ids === undefined) return
    ids.delete(entry.id)
    if (ids.size === 0) byChannel.delete(entry.scope)
  }

  /** Serialize this prompt's Slack writes so the last rendered state wins. */
  function enqueue(entry, work) {
    entry.chain = entry.chain
      .then(work)
      .catch((error) => logger.warn('prompt update failed in ' + entry.channel + ': ' + errorText(error)))
    return entry.chain
  }

  /** One pending prompt, with its deferred decision and Slack message state. */
  function newEntry(fields) {
    const deferred = Promise.withResolvers()
    return {
      id: randomUUID(),
      settled: false,
      messageTs: undefined,
      timer: undefined,
      detachAbort: undefined,
      chain: Promise.resolve(),
      decision: deferred.promise,
      decide: deferred.resolve,
      ...fields,
    }
  }

  function armDeadline(entry, onExpire) {
    if (!(timeoutMs > 0)) return
    entry.timer = setTimeout(onExpire, timeoutMs)
    entry.timer.unref?.() // a pending prompt must never hold the process open
  }

  /** Release the resources of a settled prompt (idempotent). */
  function release(entry) {
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer)
      entry.timer = undefined
    }
    if (entry.detachAbort !== undefined) {
      entry.detachAbort()
      entry.detachAbort = undefined
    }
    untrack(entry)
  }

  /**
   * Settle one prompt exactly once: release, resolve the awaiting answerer,
   * and re-render the Slack message without its buttons. `silent` skips the
   * render (teardown, or a prompt that never reached Slack).
   */
  function conclude(entry, decision) {
    if (entry.settled === true) return false
    entry.settled = true
    release(entry)
    entry.decide({ source: 'slack', ...decision })
    if (decision.silent !== true) {
      enqueue(entry, () => updatePrompt(entry, settledBlocks(entry, decision), settledText(entry, decision)))
    }
    return true
  }

  /** Post one prompt message and record its ts. */
  async function postPrompt(entry) {
    const posted = await slack.postMessage(entry.channel, promptText(entry), {
      threadTs: entry.threadTs,
      blocks: promptBlocks(entry),
    })
    entry.messageTs = posted?.ts
  }

  /**
   * Post the prompt, recording the Slack message id a settle needs to retire
   * its buttons. The attempt is remembered (not just awaited) so a decision
   * that races the post — a text command typed the moment the prompt appears —
   * still updates the message once it exists. A failure settles the prompt
   * fail-closed: nobody can answer what Slack never showed.
   */
  async function beginPrompt(entry) {
    entry.posted = postPrompt(entry).then(
      () => undefined,
      (error) => {
        logger.warn('could not post the ' + entry.kind + ' prompt in ' + entry.channel + ': ' + errorText(error))
        return error
      },
    )
    const failure = await entry.posted
    if (failure !== undefined) {
      conclude(entry, entry.kind === 'approval'
        ? { outcome: 'unavailable', postFailed: true }
        : { error: 'the question could not be shown in the channel', postFailed: true })
    }
  }

  async function updatePrompt(entry, blocks, fallbackText) {
    // A settle can outrun the post it belongs to; wait for the message id.
    if (entry.posted !== undefined) await entry.posted
    if (entry.messageTs === undefined) return
    await slack.updateMessage(entry.channel, entry.messageTs, fallbackText, { blocks })
  }

  /** A racer that only speaks for a downstream answerer with a real decision. */
  function decisiveApproval(next) {
    return Promise.resolve()
      .then(() => next())
      .then(
        (outcome) => (outcome === 'unavailable' ? NEVER : { source: 'downstream', outcome }),
        () => NEVER, // a throwing answerer fails closed downstream; Slack still gets its chance
      )
  }

  /** A racer that only speaks for a downstream answerer that actually answered. */
  function decisiveAnswer(next) {
    return Promise.resolve()
      .then(() => next())
      .then(
        (answer) => ({ source: 'downstream', answer }),
        () => NEVER, // no answerer accepted (NO_PROVIDER) or it failed: keep waiting for Slack
      )
  }

  /**
   * Ask the channel to decide one approval. Owned agents get the Slack prompt;
   * every other agent (a subagent, a web session) delegates untouched.
   * @returns the closed outcome the approval service expects.
   */
  async function answerApproval(request, next) {
    const record = ownedRecord(request.agent)
    if (record === undefined) return next()
    // Handing over (receive off): clicks and !allow now reach the other host,
    // so a prompt posted here could only expire. Decline it at once.
    if (receiving() === false) {
      logger.info('approval declined: this host no longer receives from Slack (handover)')
      return 'unavailable'
    }
    // The service races the signal itself; this is the belt-and-braces case of
    // a request that was already withdrawn when it reached us.
    if (request.signal?.aborted === true) return 'cancelled'
    const entry = newEntry({
      kind: 'approval',
      channel: record.chatId,
      scope: record.key ?? String(record.chatId),
      threadTs: threadOf(record),
      request,
    })
    track(entry)
    armDeadline(entry, () => conclude(entry, { outcome: 'unavailable', expired: true }))
    const signal = request.signal
    if (signal !== undefined) {
      const onAbort = () => conclude(entry, { outcome: 'cancelled', aborted: true })
      signal.addEventListener('abort', onAbort, { once: true })
      entry.detachAbort = () => signal.removeEventListener('abort', onAbort)
    }
    await beginPrompt(entry)
    try {
      const result = await Promise.race([entry.decision, decisiveApproval(next)])
      if (result.source === 'downstream') conclude(entry, { outcome: result.outcome, downstream: true })
      return result.outcome
    } finally {
      release(entry)
    }
  }

  /**
   * Ask the channel one batch of questions. Owned agents get the Slack prompt;
   * every other agent delegates untouched.
   * @returns the answer batch, or throws when the prompt expired or was cancelled.
   */
  async function answerQuestion(request, next) {
    const record = ownedRecord(request.agent)
    if (record === undefined) return next()
    if (receiving() === false) {
      logger.info('question declined: this host no longer receives from Slack (handover)')
      throw new Error('ask_user_question: this Slack channel is handing over to another host and can no longer receive answers here — continue without asking, and say in your final reply what you still need')
    }
    if (request.signal?.aborted === true) throw new Error('ask_user_question: the question was cancelled')
    const entry = newEntry({
      kind: 'question',
      channel: record.chatId,
      scope: record.key ?? String(record.chatId),
      threadTs: threadOf(record),
      questions: normalizeQuestions(request.questions),
      /** question id → committed answer item. */
      answers: new Map(),
      /** question id → in-progress multi-select labels (until Submit). */
      selecting: new Map(),
    })
    track(entry)
    armDeadline(entry, () => conclude(entry, { error: 'no answer within ' + humanDuration(timeoutMs), expired: true }))
    const signal = request.signal
    if (signal !== undefined) {
      const onAbort = () => conclude(entry, { error: 'the question was cancelled', aborted: true })
      signal.addEventListener('abort', onAbort, { once: true })
      entry.detachAbort = () => signal.removeEventListener('abort', onAbort)
    }
    await beginPrompt(entry)
    try {
      const result = await Promise.race([entry.decision, decisiveAnswer(next)])
      if (result.source === 'downstream') conclude(entry, { answer: result.answer, downstream: true })
      if (result.answer !== undefined) return result.answer
      throw new Error(result.error ?? 'ask_user_question: the question was not answered')
    } finally {
      release(entry)
    }
  }

  /** The oldest still-open question prompt in a channel, if any. */
  function oldestQuestion(channel) {
    const ids = byChannel.get(String(channel))
    if (ids === undefined) return undefined
    for (const id of ids) {
      const entry = pending.get(id)
      if (entry !== undefined && entry.kind === 'question' && entry.settled === false) return entry
    }
    return undefined
  }

  /** The oldest still-open approval prompt in a channel, if any. */
  function oldestApproval(channel) {
    const ids = byChannel.get(String(channel))
    if (ids === undefined) return undefined
    for (const id of ids) {
      const entry = pending.get(id)
      if (entry !== undefined && entry.kind === 'approval' && entry.settled === false) return entry
    }
    return undefined
  }

  /** Whether a prompt is waiting in this channel (for queue acks and notices). */
  function hasPending(channel) {
    const ids = byChannel.get(String(channel))
    return ids !== undefined && ids.size > 0
  }

  /** The answer batch as the user-questions seam expects it. */
  function buildAnswer(entry) {
    return {
      answers: entry.questions.map((question) => entry.answers.get(question.id) ?? { id: question.id, selected: [] }),
    }
  }

  /** Commit one answer item, then settle the batch if every question has one. */
  function commitAnswer(entry, questionId, item, actorId) {
    entry.answers.set(questionId, item)
    entry.selecting.delete(questionId)
    if (entry.questions.every((question) => entry.answers.has(question.id))) {
      conclude(entry, { answer: buildAnswer(entry), actorId })
      return
    }
    enqueue(entry, () => updatePrompt(entry, promptBlocks(entry), promptText(entry)))
  }

  /** One option button: select (single) or toggle (multi, committed by Submit). */
  function clickOption(entry, value, actorId) {
    if (entry.kind !== 'question') return
    const question = entry.questions.find((item) => item.id === value.q)
    const option = question?.options?.[value.i]
    if (option === undefined) return
    if (question.multiSelect === true) {
      // A toggle starts from the committed selection, so re-answering a
      // multi-select question does not silently discard what was chosen.
      const chosen = new Set(entry.selecting.get(question.id) ?? entry.answers.get(question.id)?.selected ?? [])
      if (chosen.has(option.label)) chosen.delete(option.label)
      else chosen.add(option.label)
      if (chosen.size === 0) entry.selecting.delete(question.id)
      else entry.selecting.set(question.id, chosen)
      enqueue(entry, () => updatePrompt(entry, promptBlocks(entry), promptText(entry)))
      return
    }
    commitAnswer(entry, question.id, { id: question.id, selected: [option.label] }, actorId)
  }

  /** The Submit button of a multi-select question commits its toggled labels. */
  function clickSubmit(entry, value, actorId) {
    if (entry.kind !== 'question') return
    const chosen = entry.selecting.get(value.q)
    if (chosen === undefined || chosen.size === 0) return
    commitAnswer(entry, value.q, { id: value.q, selected: [...chosen] }, actorId)
  }

  /** Decode one button value: a bare prompt id, or the question payload. */
  function parseActionValue(raw) {
    if (typeof raw !== 'string' || raw.length === 0) return undefined
    if (raw.startsWith('{') === false) return { p: raw }
    try {
      const parsed = JSON.parse(raw)
      return typeof parsed?.p === 'string' ? parsed : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Handle one Slack interactive payload (a Block Kit button click). Clicks
   * from unauthorized channels and clicks on already-settled prompts are
   * ignored: the buttons are the only actor, but the value they carry is
   * checked against the live pending set rather than trusted.
   */
  async function handleInteractive(payload) {
    if (payload?.type !== 'block_actions') return
    const channel = payload.channel?.id
    if (typeof channel !== 'string' || channel.length === 0) return
    if (authorized(channel) !== true) {
      logger.warn('ignored an interaction from unauthorized channel ' + channel)
      return
    }
    const actorId = SLACK_USER_ID.test(text(payload.user?.id)) ? payload.user.id : undefined
    for (const action of payload.actions ?? []) {
      const value = parseActionValue(action?.value)
      if (value === undefined) continue
      const entry = pending.get(String(value.p))
      if (entry === undefined) {
        logger.info('ignored a click on a prompt that is no longer pending')
        continue
      }
      if (entry.channel !== channel) continue
      if (action.action_id === ACTION_APPROVAL_ALLOW) conclude(entry, { outcome: 'allowed-once', actorId })
      else if (action.action_id === ACTION_APPROVAL_DENY) conclude(entry, { outcome: 'rejected', actorId })
      else if (isQuestionOptionAction(action.action_id)) clickOption(entry, value, actorId)
      else if (action.action_id === ACTION_QUESTION_SUBMIT) clickSubmit(entry, value, actorId)
    }
  }

  /**
   * Answer a pending prompt from channel text. A bare message answers an
   * option-less question (the only prompt with nothing to click); the explicit
   * `!answer …` spelling is the free-form "Other" answer for any question, and
   * `!allow` / `!deny` decide an approval.
   * @returns whether the message was consumed as an answer.
   */
  function answerFromText(channel, verb, body, actorId) {
    const key = String(channel)
    if (verb === 'allow' || verb === 'deny') {
      const entry = oldestApproval(key)
      if (entry === undefined) return false
      conclude(entry, { outcome: verb === 'allow' ? 'allowed-once' : 'rejected', actorId })
      return true
    }
    const entry = oldestQuestion(key)
    if (entry === undefined) return false
    const question = entry.questions.find((item) => entry.answers.has(item.id) === false)
    if (question === undefined) return false
    const answer = text(body).trim()
    if (answer.length === 0) return false
    const explicit = verb === 'answer'
    if (explicit === false && (question.options?.length ?? 0) > 0) return false
    commitAnswer(entry, question.id, { id: question.id, selected: [], custom: answer }, actorId)
    return true
  }

  /** Settle every pending prompt (teardown): no Slack write, no waiting. */
  function disposeAll() {
    for (const entry of [...pending.values()]) {
      conclude(entry, entry.kind === 'approval'
        ? { outcome: 'cancelled', silent: true }
        : { error: 'the channel session was disposed', silent: true })
    }
  }

  // ── rendering ──────────────────────────────────────────────────────────
  // Prompt text is model-written (the ask reason, the questions, the option
  // labels), so it goes through the same mrkdwn escaping as a reply: nothing
  // in a prompt can become a link or a ping by accident.

  function escape(value) {
    return toSlackMrkdwn(text(value), mrkdwnOptions)
  }

  function promptText(entry) {
    if (entry.kind === 'approval') {
      const reason = clip(entry.request.reason ?? entry.request.displayReason, FALLBACK_TEXT_MAX)
      return clip('Approval required: ' + text(entry.request.toolName) + (reason.length > 0 ? ' — ' + reason : ''), FALLBACK_TEXT_MAX)
    }
    return clip('Input needed: ' + entry.questions.map((question) => question.question).join(' / '), FALLBACK_TEXT_MAX)
  }

  function approvalFooter() {
    const expiry = timeoutMs > 0 ? ' Expires in ' + humanDuration(timeoutMs) + '.' : ' Waits until the turn is stopped.'
    return '_Allow once only — use the buttons below, or `!allow` / `!deny`.' + expiry + '_'
  }

  function approvalSection(entry) {
    const lines = [':lock: *Approval required* — ' + codeSpan(entry.request.toolName)]
    const reason = clip(entry.request.reason ?? entry.request.displayReason, REASON_MAX)
    if (reason.trim().length > 0) lines.push(escape(reason))
    lines.push(approvalFooter())
    return clip(lines.join('\n\n'), SECTION_TEXT_MAX)
  }

  function approvalButtons(entry) {
    return {
      type: 'actions',
      block_id: 'dsh-approval',
      elements: [
        {
          type: 'button',
          action_id: ACTION_APPROVAL_ALLOW,
          style: 'primary',
          value: entry.id,
          text: { type: 'plain_text', text: 'Allow once' },
        },
        {
          type: 'button',
          action_id: ACTION_APPROVAL_DENY,
          style: 'danger',
          value: entry.id,
          text: { type: 'plain_text', text: 'Deny' },
        },
      ],
    }
  }

  function questionSection(entry, question, index) {
    const answer = entry.answers.get(question.id)
    const lines = []
    if (question.header.length > 0) lines.push('*' + escape(question.header) + '*')
    lines.push(escape(question.question))
    if (question.detail.length > 0) lines.push('_' + escape(clip(question.detail, DETAIL_MAX)) + '_')
    // Slack cuts button text short and has no room for an option's
    // description, which can carry what choosing it does; spell them out.
    const options = question.options ?? []
    if (options.some((option) => option.description.length > 0 || option.label.length > BUTTON_LABEL_VISIBLE)) {
      for (const option of options) {
        const description = option.description.length > 0 ? ' — ' + clip(option.description, OPTION_DESCRIPTION_MAX) : ''
        lines.push(escape('• ' + option.label + description))
      }
    }
    if (answer !== undefined) {
      const shown = answer.custom !== undefined ? answer.custom : answer.selected.join(', ')
      lines.push('→ ' + (shown.length > 0 ? '✅ ' + escape(shown) : '_skipped_'))
    }
    return { type: 'section', text: { type: 'mrkdwn', text: clip(lines.join('\n'), SECTION_TEXT_MAX) }, block_id: 'dsh-q-' + index }
  }

  function questionRows(entry, question, index) {
    const answer = entry.answers.get(question.id)
    // An in-progress multi-select toggle outranks the committed answer: it is
    // what the next Submit will commit.
    const chosen = new Set(entry.selecting.get(question.id) ?? answer?.selected ?? [])
    const elements = (question.options ?? []).map((option, optionIndex) => ({
      type: 'button',
      action_id: questionOptionActionId(optionIndex),
      value: JSON.stringify({ p: entry.id, q: question.id, i: optionIndex }),
      text: { type: 'plain_text', text: (chosen.has(option.label) ? '✅ ' : '') + clip(option.label, BUTTON_LABEL_MAX - 2) },
    }))
    if (question.multiSelect === true && (entry.selecting.get(question.id)?.size ?? 0) > 0) {
      elements.push({
        type: 'button',
        action_id: ACTION_QUESTION_SUBMIT,
        style: 'primary',
        value: JSON.stringify({ p: entry.id, q: question.id, submit: true }),
        text: { type: 'plain_text', text: 'Submit selection' },
      })
    }
    const rows = []
    for (let at = 0; at < elements.length; at += BUTTONS_PER_ROW) {
      rows.push({ type: 'actions', block_id: 'dsh-q-' + index + '-' + at, elements: elements.slice(at, at + BUTTONS_PER_ROW) })
    }
    return rows
  }

  function questionFooter(entry) {
    const freeForm = entry.questions.some((question) => (question.options?.length ?? 0) === 0)
    const hint = freeForm ? ' Reply in this channel (or `!answer <text>`) to answer in your own words.' : ' Use `!answer <text>` for an answer that is not listed.'
    const expiry = timeoutMs > 0 ? ' Expires in ' + humanDuration(timeoutMs) + '.' : ' Waits until the turn is stopped.'
    // No space after the opening underscore, or Slack shows it literally.
    return '_' + (hint + expiry).trim() + '_'
  }

  /** One compact fallback prompt (too many questions to render as buttons). */
  function compactBlocks(entry, reason) {
    const lines = [':question: *Input needed* — ' + entry.questions.length + ' question(s)']
    for (const question of entry.questions) {
      const answer = entry.answers.get(question.id)
      const shown = answer === undefined ? '' : ' → ✅ ' + (answer.custom ?? answer.selected.join(', '))
      lines.push('• ' + question.question + shown)
    }
    lines.push('')
    lines.push('_' + reason + ' Reply with `!answer <text>` to answer._')
    return [{ type: 'section', text: { type: 'mrkdwn', text: clip(escape(lines.join('\n')), SECTION_TEXT_MAX) } }]
  }

  function promptBlocks(entry) {
    if (entry.kind === 'approval') return [{ type: 'section', text: { type: 'mrkdwn', text: approvalSection(entry) } }, approvalButtons(entry)]
    const blocks = [{
      type: 'section',
      text: { type: 'mrkdwn', text: ':question: *Input needed* — ' + entry.questions.length + ' question(s)' },
    }]
    entry.questions.forEach((question, index) => {
      blocks.push(questionSection(entry, question, index))
      blocks.push(...questionRows(entry, question, index))
    })
    if (blocks.length + 1 > BLOCKS_MAX) return compactBlocks(entry, 'This batch is too large to render as buttons.')
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: clip(questionFooter(entry), SECTION_TEXT_MAX) } })
    return blocks
  }

  /** Who decided, as a raw mention (only a genuine Slack user id qualifies). */
  function actorSuffix(decision) {
    const actorId = decision.actorId
    if (typeof actorId !== 'string' || SLACK_USER_ID.test(actorId) === false) return ''
    return ' by <@' + actorId + '>'
  }

  /** The final, button-free rendering of a settled prompt. */
  function settledBlocks(entry, decision) {
    const lines = []
    if (entry.kind === 'approval') {
      lines.push(':lock: *Approval — ' + codeSpan(entry.request.toolName) + '*')
      const reason = clip(entry.request.reason ?? entry.request.displayReason, REASON_MAX)
      if (reason.trim().length > 0) lines.push(escape(reason))
      if (decision.outcome === 'allowed-once') lines.push('✅ *Allowed once*' + actorSuffix(decision) + (decision.downstream === true ? ' (answered in the DSH UI)' : ''))
      else if (decision.outcome === 'rejected') lines.push('⛔ *Denied*' + actorSuffix(decision) + (decision.downstream === true ? ' (answered in the DSH UI)' : ''))
      else if (decision.aborted === true) lines.push('🚫 *Cancelled* — the turn was stopped.')
      else if (decision.postFailed === true) lines.push('⚠️ *Not asked here* — the prompt could not be posted, so the operation was not approved.')
      else lines.push('⌛ *Expired* — no answer within ' + humanDuration(timeoutMs) + '; the operation was not approved.')
    } else {
      lines.push(':question: *Input needed*')
      for (const question of entry.questions) {
        const answer = entry.answers.get(question.id)
        const shown = answer === undefined ? '' : ' → ✅ ' + (answer.custom ?? answer.selected.join(', '))
        lines.push(escape('• ' + question.question + shown))
      }
      if (decision.answer !== undefined) lines.push('✅ *Answered*' + actorSuffix(decision) + (decision.downstream === true ? ' (answered in the DSH UI)' : ''))
      else if (decision.aborted === true) lines.push('🚫 *Cancelled* — the turn was stopped.')
      else if (decision.postFailed === true) lines.push('⚠️ *Not asked here* — the prompt could not be posted.')
      else lines.push('⌛ *Expired* — no answer within ' + humanDuration(timeoutMs) + '.')
    }
    return [{ type: 'section', text: { type: 'mrkdwn', text: clip(lines.join('\n\n'), SECTION_TEXT_MAX) } }]
  }

  function settledText(entry, decision) {
    if (entry.kind === 'approval') {
      if (decision.outcome === 'allowed-once') return 'Approval: allowed once'
      if (decision.outcome === 'rejected') return 'Approval: denied'
      if (decision.aborted === true) return 'Approval: cancelled'
      if (decision.postFailed === true) return 'Approval: could not be asked in the channel'
      return 'Approval: expired without an answer'
    }
    if (decision.answer !== undefined) return 'Questions answered'
    if (decision.aborted === true) return 'Questions cancelled'
    if (decision.postFailed === true) return 'Questions could not be asked in the channel'
    return 'Questions expired without an answer'
  }

  /** Normalize the tool's question items into the shape the renderer wants. */
  function normalizeQuestions(raw) {
    const list = Array.isArray(raw) ? raw : []
    return list.map((question, index) => ({
      id: typeof question?.id === 'string' && question.id.length > 0 ? question.id : 'q' + index,
      question: text(question?.question),
      header: text(question?.header),
      detail: text(question?.detail),
      multiSelect: question?.multiSelect === true,
      options: (Array.isArray(question?.options) ? question.options : [])
        .filter((option) => typeof option?.label === 'string')
        .map((option) => ({ label: option.label, description: text(option.description) })),
    }))
  }

  return {
    answerApproval,
    answerQuestion,
    handleInteractive,
    answerFromText,
    hasPending,
    disposeAll,
  }
}
