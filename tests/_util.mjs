// Tiny dependency-free test harness for dsh-slack-channel: a mock Slack Web
// API HTTP server plus a scripted fake websocket for the Socket Mode loop.

import http from 'node:http'

let failures = 0
let runs = 0
const pending = []

/** Register one (possibly async) test; summary() awaits every promise. */
export function test(name, fn) {
  runs++
  pending.push((async () => {
    try {
      await fn()
      process.stdout.write('  ok  ' + name + '\n')
    } catch (error) {
      failures++
      process.stdout.write('  FAIL ' + name + ': ' + (error?.message ?? String(error)) + '\n')
    }
  })())
}

/** Await every registered test, then exit (non-zero on any failure). */
export async function summary() {
  await Promise.all(pending)
  process.stdout.write('\n' + (runs - failures) + '/' + runs + ' passed\n')
  // Hard exit: a failed test can leave an undisposed socket loop alive.
  process.exit(failures > 0 ? 1 : 0)
}

/** Assert a condition with a message. */
export function assert(condition, message) {
  if (!condition) throw new Error(message ?? 'assertion failed')
}

/** Deep-equal two JSON values. */
export function equal(actual, expected, message) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error((message ?? 'not equal') + ': ' + a + ' !== ' + b)
}

/** Sleep ms. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Poll until fn() returns truthy or the timeout elapses. */
export async function waitFor(fn, timeoutMs = 4000, stepMs = 20) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = fn()
    if (value) return value
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await sleep(stepMs)
  }
}

/**
 * The first Block Kit rule a payload breaks that real Slack enforces, or
 * undefined. Slack requires every action_id to be unique within its
 * containing block and refuses the whole message otherwise — the mock does
 * too, so a prompt that would never reach a real channel fails here.
 */
export function blockKitViolation(blocks) {
  if (!Array.isArray(blocks)) return undefined
  for (const block of blocks) {
    const seen = new Set()
    for (const element of block?.elements ?? []) {
      const actionId = element?.action_id
      if (typeof actionId !== 'string') continue
      if (seen.has(actionId)) return 'duplicate action_id ' + actionId + ' in block ' + (block.block_id ?? '?')
      seen.add(actionId)
    }
  }
  return undefined
}

/**
 * Start one mock Slack Web API server. Records every call (method, token
 * kind, body); serves canned responses per method; supports per-test
 * overrides. apps.connections.open only succeeds for xapp- tokens; message
 * writes with invalid blocks fail with invalid_blocks, as on real Slack.
 */
export async function startMockSlack() {
  const calls = []
  let override = null
  let postTs = 1700000000
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      void (async () => {
        const method = req.url.replace(/^\/api\//, '').replace(/^\//, '')
        const auth = req.headers.authorization ?? ''
        const token = auth.replace(/^Bearer /, '')
        let body = {}
        try { body = JSON.parse(raw === '' ? '{}' : raw) } catch { /* leave {} */ }
        calls.push({ method, token, body })
        await sleep(5) // keep loops from spinning hot
        let status = 200
        let reply = { ok: true }
        if (method === 'apps.connections.open') {
          if (token.startsWith('xapp-')) reply = { ok: true, url: 'wss://mock-socket/' + calls.length }
          else reply = { ok: false, error: 'invalid_auth' }
        } else if ((method === 'chat.postMessage' || method === 'chat.update') && blockKitViolation(body.blocks) !== undefined) {
          reply = { ok: false, error: 'invalid_blocks', errors: [blockKitViolation(body.blocks)] }
        } else if (method === 'chat.postMessage') {
          postTs += 1
          reply = { ok: true, channel: body.channel, ts: postTs + '.001' }
        } else if (method === 'reactions.add' || method === 'reactions.remove') {
          reply = { ok: true }
        }
        if (override !== null) {
          const over = override(method, body, token, calls.length)
          if (over !== undefined && over !== null) {
            if (over.status !== undefined) status = over.status
            if (over.reply !== undefined) reply = over.reply
          }
        }
        if (status === 429) res.writeHead(status, { 'retry-after': String(reply.retryAfterSec ?? 0) })
        else res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(reply))
      })()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    url: 'http://127.0.0.1:' + address.port,
    calls,
    setHandler(fn) { override = fn },
    close() {
      server.closeAllConnections?.()
      return new Promise((resolve) => server.close(resolve))
    },
  }
}

/**
 * Scripted fake websocket: dispatches events synchronously to listeners,
 * records sent frames, and lets tests close or fail the connection.
 */
export class FakeSlackSocket {
  constructor() {
    this.sent = []
    this.listeners = { message: [], close: [], error: [], open: [] }
    this.open = true
  }

  addEventListener(type, fn) {
    ;(this.listeners[type] ??= []).push(fn)
  }

  send(data) {
    if (this.open === false) throw new Error('socket closed')
    this.sent.push(JSON.parse(data))
  }

  /** Deliver one server frame (parsed object) to the client. */
  receive(envelope) {
    const event = { data: JSON.stringify(envelope) }
    for (const fn of [...(this.listeners.message ?? [])]) fn(event)
  }

  close() {
    if (this.open === false) return
    this.open = false
    for (const fn of [...(this.listeners.close ?? [])]) fn({})
  }

  fail() {
    for (const fn of [...(this.listeners.error ?? [])]) fn(new Error('boom'))
    this.close()
  }
}
