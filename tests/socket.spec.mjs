// Socket Mode loop tests with scripted fake websockets.

import { test, assert, equal, startMockSlack, sleep, waitFor, FakeSlackSocket } from './_util.mjs'
import { SlackClient } from '../src/slack.js'
import { runSocketLoop } from '../src/socket.js'

function loggerOf(logs) {
  return {
    info: () => {},
    warn: (...a) => logs.push('warn ' + a.join(' ')),
    error: (...a) => logs.push('error ' + a.join(' ')),
  }
}

test('events_api envelopes are acked and routed to the handler', async () => {
  const mock = await startMockSlack()
  try {
    const client = new SlackClient({ apiBase: mock.url, botToken: 'xoxb-t', appToken: 'xapp-t' })
    const socket = new FakeSlackSocket()
    const events = []
    const controller = new AbortController()
    const loop = runSocketLoop({
      slack: client,
      onEvent: (event) => events.push(event),
      signal: controller.signal,
      logger: loggerOf([]),
      retryDelayMs: 10,
      wsFactory: async () => socket,
    })
    await waitFor(() => socket.listeners.message?.length > 0)
    socket.receive({ envelope_id: 'e-1', type: 'events_api', payload: { event: { type: 'message', text: 'hi' } } })
    await sleep(50)
    equal(events, [{ type: 'message', text: 'hi' }], 'event routed')
    equal(socket.sent, [{ envelope_id: 'e-1' }], 'envelope acked')
    controller.abort()
    socket.close()
    await loop
  } finally {
    await mock.close()
  }
})

test('hello frames are tolerated and unknown types ignored', async () => {
  const mock = await startMockSlack()
  try {
    const client = new SlackClient({ apiBase: mock.url, botToken: 'xoxb-t', appToken: 'xapp-t' })
    const socket = new FakeSlackSocket()
    const events = []
    const controller = new AbortController()
    const loop = runSocketLoop({
      slack: client,
      onEvent: (event) => events.push(event),
      signal: controller.signal,
      logger: loggerOf([]),
      retryDelayMs: 10,
      wsFactory: async () => socket,
    })
    await waitFor(() => socket.listeners.message?.length > 0)
    socket.receive({ type: 'hello' })
    socket.receive({ type: 'something_new', data: 1 })
    await sleep(30)
    equal(events, [], 'no events routed for non-events_api frames')
    controller.abort()
    socket.close()
    await loop
  } finally {
    await mock.close()
  }
})

test('interactive envelopes are acked and routed to the interactive handler', async () => {
  const mock = await startMockSlack()
  try {
    const client = new SlackClient({ apiBase: mock.url, botToken: 'xoxb-t', appToken: 'xapp-t' })
    const socket = new FakeSlackSocket()
    const events = []
    const clicked = []
    const logged = []
    const controller = new AbortController()
    const loop = runSocketLoop({
      slack: client,
      onEvent: (event) => events.push(event),
      onInteractive: (payload) => { clicked.push(payload) },
      signal: controller.signal,
      logger: loggerOf(logged),
      retryDelayMs: 10,
      wsFactory: async () => socket,
    })
    await waitFor(() => socket.listeners.message?.length > 0)
    socket.receive({ envelope_id: 'i-1', type: 'interactive', payload: { type: 'block_actions', actions: [{ action_id: 'a' }] } })
    await sleep(30)
    equal(clicked, [{ type: 'block_actions', actions: [{ action_id: 'a' }] }], 'interactive payload routed')
    equal(events, [], 'interactive frames are not events')
    equal(socket.sent, [{ envelope_id: 'i-1' }], 'envelope acked')
    controller.abort()
    socket.close()
    await loop
    equal(logged, [], 'nothing logged for a handled click')
  } finally {
    await mock.close()
  }
})

test('a rejected interactive handler is contained and logged', async () => {
  const mock = await startMockSlack()
  try {
    const client = new SlackClient({ apiBase: mock.url, botToken: 'xoxb-t', appToken: 'xapp-t' })
    const socket = new FakeSlackSocket()
    const logged = []
    const controller = new AbortController()
    const loop = runSocketLoop({
      slack: client,
      onEvent: () => {},
      onInteractive: () => Promise.reject(new Error('click blew up')),
      signal: controller.signal,
      logger: loggerOf(logged),
      retryDelayMs: 10,
      wsFactory: async () => socket,
    })
    await waitFor(() => socket.listeners.message?.length > 0)
    socket.receive({ envelope_id: 'i-2', type: 'interactive', payload: { type: 'block_actions' } })
    await waitFor(() => logged.length > 0)
    assert(logged[0].includes('click blew up'), 'the failure is reported: ' + logged[0])
    controller.abort()
    socket.close()
    await loop
  } finally {
    await mock.close()
  }
})

test('socket close triggers reconnect with a fresh URL', async () => {
  const mock = await startMockSlack()
  try {
    const client = new SlackClient({ apiBase: mock.url, botToken: 'xoxb-t', appToken: 'xapp-t' })
    const created = []
    const controller = new AbortController()
    const loop = runSocketLoop({
      slack: client,
      onEvent: () => {},
      signal: controller.signal,
      logger: loggerOf([]),
      retryDelayMs: 10,
      wsFactory: async () => {
        const socket = new FakeSlackSocket()
        created.push(socket)
        return socket
      },
    })
    await waitFor(() => created.length >= 1)
    const opensBefore = mock.calls.filter((c) => c.method === 'apps.connections.open').length
    // Close the live connection: the loop must mint a NEW url and connect
    // again through the factory.
    created[0].close()
    await waitFor(() => created.length >= 2)
    const opensAfter = mock.calls.filter((c) => c.method === 'apps.connections.open').length
    assert(opensAfter >= opensBefore + 1, 'fresh apps.connections.open call after close')
    controller.abort()
    created[1]?.close()
    await loop
  } finally {
    await mock.close()
  }
})

test('abort stops the loop even mid-connection', async () => {
  const mock = await startMockSlack()
  try {
    const client = new SlackClient({ apiBase: mock.url, botToken: 'xoxb-t', appToken: 'xapp-t' })
    const socket = new FakeSlackSocket()
    const controller = new AbortController()
    const loop = runSocketLoop({
      slack: client,
      onEvent: () => {},
      signal: controller.signal,
      logger: loggerOf([]),
      retryDelayMs: 10,
      wsFactory: async () => socket,
    })
    await waitFor(() => socket.listeners.message?.length > 0)
    controller.abort()
    socket.close()
    await loop
    const opens = mock.calls.filter((c) => c.method === 'apps.connections.open').length
    await sleep(60)
    equal(mock.calls.filter((c) => c.method === 'apps.connections.open').length, opens, 'no reconnect after abort')
  } finally {
    await mock.close()
  }
})
