// Slack Socket Mode connection loop.
//
// The protocol: POST apps.connections.open (app-level token) mints ONE
// single-use wss:// URL; connecting delivers a {type:"hello"} frame; events
// arrive as envelopes {envelope_id, type:"events_api", payload:{event}} that
// MUST be acknowledged with {envelope_id}; Slack closes connections
// periodically, so the loop reconnects with fresh URLs until aborted.
//
// The websocket is injected (wsFactory) so tests drive the loop with a
// scripted fake instead of a real socket.

import { sleep } from './slack.js'

/**
 * Run the Socket Mode loop until the signal aborts.
 * @param options.slack - a SlackClient (openConnections uses the app token).
 * @param options.onEvent - receives each Slack event
 *   (payload.event of events_api envelopes).
 * @param options.onInteractive - receives each interactive payload
 *   (payload of interactive envelopes: Block Kit button clicks).
 * @param options.signal - aborts the loop (plugin teardown).
 * @param options.logger - named plugin logger for diagnostics.
 * @param options.retryDelayMs - backoff after failures and disconnects.
 * @param options.wsFactory - async (url) => websocket-like object with
 *   addEventListener('open'|'message'|'close'|'error', fn), send(string),
 *   close(). Defaults to globalThis.WebSocket.
 */
export async function runSocketLoop({ slack, onEvent, onInteractive, signal, logger, retryDelayMs = 2000, wsFactory }) {
  const factory = wsFactory ?? (async (url) => new WebSocket(url))
  while (signal.aborted === false) {
    let url
    try {
      const opened = await slack.openConnections(signal)
      url = opened.url
    } catch (error) {
      if (signal.aborted) break
      logger.warn('apps.connections.open failed (' + errorText(error) + '); retrying in ' + retryDelayMs + 'ms')
      await sleep(retryDelayMs, signal)
      continue
    }
    if (signal.aborted) break

    let ws
    try {
      ws = await factory(url)
    } catch (error) {
      if (signal.aborted) break
      logger.warn('socket connect failed (' + errorText(error) + '); retrying in ' + retryDelayMs + 'ms')
      await sleep(retryDelayMs, signal)
      continue
    }

    const closed = Promise.withResolvers()
    // Teardown aborts the signal; a live socket would otherwise hold the
    // loop on closed.promise forever. Close it on abort.
    const onAbort = () => {
      try { ws.close() } catch { /* already closed */ }
    }
    signal.addEventListener('abort', onAbort, { once: true })
    ws.addEventListener('message', (event) => {
      if (signal.aborted) return // teardown: no acks, no event handling
      let envelope
      try {
        envelope = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
      } catch {
        return // non-JSON frame: ignore
      }
      // Every envelope wants an ack, keyed by envelope_id.
      if (typeof envelope.envelope_id === 'string') {
        try { ws.send(JSON.stringify({ envelope_id: envelope.envelope_id })) } catch { /* closing */ }
      }
      if (envelope.type === 'events_api') {
        const slackEvent = envelope.payload?.event
        if (slackEvent !== undefined) {
          try {
            onEvent(slackEvent)
          } catch (error) {
            logger.warn('event handling failed: ' + errorText(error))
          }
        }
      } else if (envelope.type === 'interactive') {
        // Block Kit clicks arrive as their own envelope type. The ack above is
        // already sent; the handler is async (it answers a pending prompt and
        // rewrites the message), so its rejection is contained here.
        const payload = envelope.payload
        if (payload !== undefined && onInteractive !== undefined) {
          try {
            Promise.resolve(onInteractive(payload)).catch((error) => logger.warn('interaction handling failed: ' + errorText(error)))
          } catch (error) {
            logger.warn('interaction handling failed: ' + errorText(error))
          }
        }
      }
      // hello, disconnect_reason and unknown types need nothing here; the
      // close handler below drives reconnection.
    })
    ws.addEventListener('close', () => closed.resolve())
    ws.addEventListener('error', () => closed.resolve())

    await closed.promise
    signal.removeEventListener('abort', onAbort)
    try { ws.close() } catch { /* already closed */ }
    if (signal.aborted) break
    logger.warn('socket closed; reconnecting in ' + retryDelayMs + 'ms')
    await sleep(retryDelayMs, signal)
  }
}

/** The stable error text an event payload carries, for logging. */
function errorText(error) {
  return error?.message ?? String(error)
}
