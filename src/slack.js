// Dependency-free Slack Web API client: global fetch, JSON bodies. No npm
// dependencies — the same transport posture as dsh-a2a-plugin and the
// dsh-telegram-channel sibling.

/** One failed Slack API call, with the machine facts needed to react. */
export class SlackApiError extends Error {
  constructor(method, status, slackError, retryAfterMs) {
    super('slack ' + method + ' failed (' + (status ?? 'no-response') + (slackError ? ': ' + slackError : '') + ')')
    this.name = 'SlackApiError'
    this.method = method
    this.status = status
    this.slackError = slackError
    this.retryAfterMs = retryAfterMs
  }
}

/**
 * Minimal Slack Web API client. Slack's contract differs from Telegram's in
 * three ways this client absorbs:
 *  - results are top-level fields (`{ ok: true, channel, ts, … }`), not a
 *    `result` envelope — call() returns the whole body minus `ok`;
 *  - failures are `{ ok: false, error }` bodies with HTTP 200;
 *  - 429 rate limits carry `Retry-After` as an HTTP header (seconds).
 */
export class SlackClient {
  #apiBase
  #botToken
  #appToken
  #fetchImpl
  #timeoutMs

  constructor({ apiBase, botToken, appToken, fetchImpl, timeoutMs = 20000 }) {
    this.#apiBase = apiBase.replace(/\/+$/, '')
    this.#botToken = botToken
    this.#appToken = appToken
    this.#fetchImpl = fetchImpl ?? globalThis.fetch
    this.#timeoutMs = timeoutMs
  }

  /**
   * Invoke one Web API method with the given bearer token.
   * @param method - Slack Web API method name (e.g. chat.postMessage).
   * @param token - the bearer token: bot (xoxb-…) for most calls,
   *   app-level (xapp-…) for apps.connections.open.
   * @param payload - JSON-serializable arguments.
   * @param options - optional abort signal.
   * @returns the response body without `ok`.
   * @throws SlackApiError on !ok bodies, HTTP errors, or transport failures.
   */
  async call(method, token, payload = {}, options = {}) {
    const url = this.#apiBase + '/' + method
    let res
    try {
      res = await this.#fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          authorization: 'Bearer ' + token,
        },
        body: JSON.stringify(payload),
        signal: options.signal ?? AbortSignal.timeout(this.#timeoutMs),
      })
    } catch (error) {
      if (options.signal?.aborted || error?.name === 'TimeoutError') throw error
      throw new SlackApiError(method, undefined, 'network error: ' + (error?.message ?? String(error)))
    }
    if (res.status === 429) {
      const header = res.headers.get('retry-after')
      throw new SlackApiError(method, 429, 'rate_limited', typeof header === 'string' && Number.isFinite(Number(header)) ? Number(header) * 1000 : undefined)
    }
    let body = null
    try { body = await res.json() } catch { /* non-JSON body */ }
    if (body === null || typeof body !== 'object' || body.ok !== true) {
      throw new SlackApiError(method, res.status, body?.error ?? 'HTTP ' + res.status)
    }
    const { ok: _ok, ...result } = body
    return result
  }

  /**
   * Request one single-use Socket Mode websocket URL (app-level token).
   * Each call mints a fresh URL; connect immediately.
   */
  openConnections(signal) {
    return this.call('apps.connections.open', this.#appToken, {}, { signal })
  }

  /**
   * Identify the installed bot: `{ bot_id, user_id, team_id, … }`.
   * The event filter needs our own ids to drop OUR messages while letting
   * other apps' messages (which carry their own bot_id) through.
   */
  authTest(signal) {
    return this.call('auth.test', this.#botToken, {}, { signal })
  }

  /**
   * Post one channel message. Slack messages are mrkdwn; the caller passes
   * already-converted text.
   * @param channelId - target channel (C…/G…/D…).
   * @param text - the message text; the caller pre-split it to the limit.
   * @param options - threadTs (reply in-thread), and abort signal.
   * @returns { channel, ts } of the posted message.
   */
  async postMessage(channelId, text, options = {}) {
    const payload = {
      channel: channelId,
      text,
      unfurl_links: false,
      unfurl_media: false,
    }
    if (options.threadTs !== undefined) payload.thread_ts = options.threadTs
    try {
      return await this.call('chat.postMessage', this.#botToken, payload, options)
    } catch (error) {
      const isRateLimit = error instanceof SlackApiError
        && error.status === 429
        && typeof error.retryAfterMs === 'number'
      if (!isRateLimit) throw error
      await sleep(error.retryAfterMs + 250, options.signal)
      return this.call('chat.postMessage', this.#botToken, payload, options)
    }
  }

  /**
   * Fire-and-forget emoji reaction on a message (the "working" indicator).
   * Failures are deliberately swallowed: an already-reacted message or a
   * missing permission must never break a reply.
   */
  async react(channelId, timestamp, name, options = {}) {
    try {
      await this.call('reactions.add', this.#botToken, { channel: channelId, timestamp, name }, options)
      return true
    } catch (error) {
      if (error instanceof SlackApiError && error.slackError === 'already_reacted') return true
      return false
    }
  }

  /** Remove one reaction; failures swallowed (unreact is best-effort). */
  async unreact(channelId, timestamp, name, options = {}) {
    try {
      await this.call('reactions.remove', this.#botToken, { channel: channelId, timestamp, name }, options)
      return true
    } catch {
      return false
    }
  }
}

/** Resolve after ms, or as soon as the signal aborts. */
export function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted || ms <= 0) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

/**
 * Split one reply into Slack-sized chunks. Chunks break at line boundaries
 * where possible; a single oversized line is hard-split. Concatenating the
 * chunks reproduces the input exactly. A chunk boundary may fall inside a
 * fenced code block; the mrkdwn formatter closes a dangling fence per chunk,
 * so every chunk still renders standalone.
 * @param text - the full reply text.
 * @param limit - maximum chunk length.
 */
export function splitMessage(text, limit) {
  if (text.length <= limit) return [text]
  // Tokenize into segments (whole lines, or hard slices of oversized lines),
  // each carrying the separator that follows it in the original text.
  const lines = text.split('\n')
  const segments = []
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]
    const sep = li < lines.length - 1 ? '\n' : ''
    if (line.length > limit) {
      const pieces = hardSplit(line, limit - 1)
      for (let pi = 0; pi < pieces.length; pi++) {
        segments.push({ text: pieces[pi], sep: pi < pieces.length - 1 ? '' : sep })
      }
    } else {
      segments.push({ text: line, sep })
    }
  }
  // Greedy fill: a chunk takes whole segments while it fits.
  const chunks = []
  let current = ''
  for (const segment of segments) {
    if (current.length > 0 && current.length + segment.text.length + segment.sep.length > limit) {
      chunks.push(current)
      current = ''
    }
    current += segment.text + segment.sep
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/** Cut one oversized line into slices of at most `limit` characters. */
function hardSplit(line, limit) {
  const pieces = []
  for (let i = 0; i < line.length; i += limit) pieces.push(line.slice(i, i + limit))
  return pieces
}
